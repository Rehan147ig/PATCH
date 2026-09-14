import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  scanDirectory,
  planCodemods,
  loadManifests,
  computeCandidateDigest,
  branchNameForDigest,
  resolveFreeBranch,
} from '@apimigrate/core';
import path from 'node:path';

/**
 * GitHub Action entrypoint.
 *
 * Runs the apimigrate scanner against the current repository, and either:
 *  - opens a PR (default), using the GITHUB_TOKEN with pull_request write permission
 *  - or fails the check if a --fail-on-hits flag is set
 */
export async function run(): Promise<void> {
  try {
    const root = process.env.GITHUB_WORKSPACE ?? process.cwd();
    const manifestsDir = core.getInput('manifests') || path.join(root, 'manifests');
    const base = core.getInput('base') || github.context.payload?.repository?.default_branch || 'main';
    const failOnHits = core.getBooleanInput('fail-on-hits');

    const manifests = await loadManifests(manifestsDir);
    if (manifests.length === 0) {
      core.warning(`No manifests found in ${manifestsDir}`);
      return;
    }
    const reports = await scanDirectory(root, manifests);
    const plan = planCodemods(reports, root);

    const totalHits = reports.reduce((n, r) => n + r.hits.length, 0);
    core.info(`apimigrate: ${totalHits} affected usage(s) across ${reports.length} manifest(s)`);
    for (const report of reports) {
      core.info(`  ${report.manifest.vendor}: ${report.manifest.title} — ${report.hits.length} hit(s)`);
    }

    if (failOnHits && totalHits > 0) {
      core.setFailed(`apimigrate found ${totalHits} affected usages that need migration`);
      return;
    }

    if (plan.changedFiles.size === 0) {
      core.info('apimigrate: no changes to apply');
      return;
    }

    // Write changes to the workspace; the surrounding workflow is responsible
    // for committing/pushing. The Action only generates the migration PR via
    // the GitHub API if a token with write scope is available.
    const { writeCodemods } = await import('@apimigrate/core');
    await writeCodemods(plan, root);

    const token = core.getInput('token') || process.env.GITHUB_TOKEN;
    if (!token) {
      core.warning('No GITHUB_TOKEN available; changes written but PR not opened');
      return;
    }

    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;

    // FR-10: candidate-specific branch; never overwrite an existing branch.
    const { digest } = await computeCandidateDigest(plan.changedFiles, reports);
    const requested = core.getInput('branch');
    const wanted = requested || branchNameForDigest(digest);
    const baseSha = github.context.sha;

    const refExists = async (branch: string): Promise<boolean> => {
      try {
        await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
        return true;
      } catch (err) {
        if ((err as { status?: number }).status === 404) return false;
        throw err;
      }
    };

    // Idempotent retry: reconcile an already-open PR instead of duplicating.
    const openForBranch = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      head: `${owner}:${wanted}`,
      base,
    });
    if (openForBranch.data.length > 0) {
      core.info(`PR already open: ${openForBranch.data[0].html_url} (reconciled, no duplicate)`);
      core.setOutput('pr-url', openForBranch.data[0].html_url);
      return;
    }

    let head = wanted;
    try {
      await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${head}`, sha: baseSha });
    } catch (err) {
      if ((err as { status?: number }).status !== 422) throw err;
      // Branch taken (user edits or prior run): leave it alone, use a free name.
      head = (await resolveFreeBranch(wanted, refExists)).branch;
      core.info(`Branch ${wanted} exists; using ${head} instead (existing ref untouched)`);
      await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${head}`, sha: baseSha });
    }

    const tree = Array.from(plan.changedFiles.entries()).map(([file, content]) => ({
      path: file,
      mode: '100644' as const,
      type: 'blob' as const,
      content,
    }));
    const { data: createdTree } = await octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseSha,
      tree,
    });
    const { data: commit } = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: 'chore(apimigrate): apply API migration',
      tree: createdTree.sha,
      parents: [baseSha],
    });
    await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${head}`, sha: commit.sha, force: false });

    const body = `${buildBody(reports)}\n\ncandidate: \`${digest.slice(0, 12)}\``;
    const { data: pr } = await octokit.rest.pulls.create({
      owner,
      repo,
      title: 'chore(apimigrate): apply API migration',
      head,
      base,
      body,
    });
    core.info(`PR opened: ${pr.html_url}`);
    core.setOutput('pr-url', pr.html_url);
  } catch (err) {
    core.setFailed((err as Error).message);
  }
}

function buildBody(reports: Awaited<ReturnType<typeof scanDirectory>>): string {
  const lines = ['## Auto-generated API migration', ''];
  for (const r of reports) {
    lines.push(`### ${r.manifest.vendor}: ${r.manifest.title}`, '');
    lines.push(`Severity: **${r.manifest.severity}** — effective ${r.manifest.changedAt}`, '');
    lines.push(`Affected usages: **${r.hits.length}**`, '');
    lines.push('', '| File | Line | Kind | Status |', '| --- | --- | --- | --- |');
    for (const h of r.hits.slice(0, 25)) {
      const status = h.replacement && h.replacement !== h.snippet ? 'fixed' : 'manual';
      lines.push(`| ${h.file} | ${h.line} | ${h.kind} | ${status} |`);
    }
    lines.push('');
  }
  lines.push('---', 'Review before merging.');
  return lines.join('\n');
}

// Only auto-run when executed directly as the GitHub Action entrypoint,
// not when imported (e.g. in tests).
if (process.env.GITHUB_ACTIONS === 'true' && process.argv[1]?.endsWith('index.js')) {
  run();
}
