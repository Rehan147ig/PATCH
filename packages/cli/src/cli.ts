#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  loadManifests,
  scanDirectory,
  planCodemods,
  writeCodemods,
  verifyCandidate,
  computeCandidateDigest,
  branchNameForDigest,
  resolveFreeBranch,
  checkFreshness,
  getBaseSha,
  getLockfileDigest,
  type MigrationManifest,
  type ScanReport,
} from '@apimigrate/core';

const program = new Command();

program
  .name('apimigrate')
  .description('API migration agent — scan codebases against API change manifests and open migration PRs')
  .version('0.1.0');

program
  .command('scan')
  .description('Scan a repository against vendor manifests and print a change report')
  .argument('[dir]', 'repository directory', '.')
  .option('-m, --manifests <dir>', 'directory of manifest JSON files', 'manifests')
  .option('-j, --json', 'emit JSON report')
  .action(async (dir: string, opts: { manifests: string; json?: boolean }) => {
    const root = path.resolve(dir);
    const manifestDir = path.resolve(opts.manifests);
    const manifests = await loadManifests(manifestDir);
    if (manifests.length === 0) {
      console.error(`No manifests found in ${manifestDir}`);
      process.exit(1);
    }
    const reports = await scanDirectory(root, manifests);
    if (opts.json) {
      console.log(JSON.stringify(reports, null, 2));
      return;
    }
    printReports(reports, root);
  });

program
  .command('apply')
  .description('Scan, apply codemods, verify build, and (optionally) open a PR')
  .argument('[dir]', 'repository directory', '.')
  .option('-m, --manifests <dir>', 'directory of manifest JSON files', 'manifests')
  .option('-p, --pr', 'open a PR with the changes (requires GitHub auth)')
  .option('--base <branch>', 'base branch for the PR', 'main')
  .option('--branch <name>', 'branch name for the PR (default: candidate-specific apimigrate/<digest>)')
  .option('--dry-run', 'plan changes without writing or pushing')
  .option('--write', 'write changes to disk (default behavior; conflicts with --dry-run)')
  .option('--allow-incomplete', 'open a PR even when verification is INCOMPLETE (explicit unverified draft)')
  .action(async (dir: string, opts: { manifests: string; pr?: boolean; base?: string; branch?: string; dryRun?: boolean; write?: boolean; allowIncomplete?: boolean }) => {
    // PRD §15: --dry-run plus --write is an explicit argument error: no writes, nonzero exit.
    if (opts.dryRun && opts.write) {
      console.error('error: --dry-run and --write are mutually exclusive (no changes written)');
      process.exitCode = 2;
      return;
    }
    const root = path.resolve(dir);
    const manifestDir = path.resolve(opts.manifests);
    const manifests = await loadManifests(manifestDir);
    const reports = await scanDirectory(root, manifests);

    const plan = planCodemods(reports, root);
    console.log(`Found ${plan.replacements} fixable replacements in ${plan.changedFiles.size} file(s)`);
    if (plan.unfixed.length > 0) {
      console.log(`${plan.unfixed.length} hit(s) require manual attention`);
    }

    if (opts.dryRun) {
      for (const [file] of plan.changedFiles) console.log(`  would change: ${file}`);
      const { digest } = await computeCandidateDigest(plan.changedFiles, reports);
      console.log(`candidate: ${digest.slice(0, 12)} (dry-run, not verified)`);
      return;
    }

    const written = await writeCodemods(plan, root);
    if (written.length === 0) {
      console.log('No changes to apply');
      return;
    }
    console.log(`Wrote ${written.length} file(s)`);

    // FR-08/FR-10: real verification with persisted evidence bound to the
    // candidate digest. Install-only success or missing tests is never VERIFIED.
    const run = await verifyCandidate(root, plan.changedFiles, reports);
    for (const d of run.dimensions) {
      console.log(`  ${d.name}: ${d.status} — ${d.reason}`);
    }
    console.log(`candidate: ${run.candidateDigest.slice(0, 12)} verdict: ${run.verdict}`);
    await persistValidation(root, run);

    if (run.verdict === 'FAILED') {
      console.error('Verification FAILED; PR not opened. Inspect the diff and validation evidence.');
      process.exitCode = 1;
      return;
    }
    if (run.verdict === 'INCOMPLETE' && !opts.allowIncomplete) {
      console.error(
        'Verification INCOMPLETE (missing behavioral evaluation); PR not opened. ' +
          'Re-run with --allow-incomplete to explicitly open an unverified draft.',
      );
      process.exitCode = 1;
      return;
    }

    if (opts.pr) {
      // FR-10: candidate-specific branch unless the user named one explicitly.
      // The legacy shared default is retired to prevent cross-candidate collisions.
      const branch =
        opts.branch && opts.branch !== 'apimigrate/auto-migration'
          ? opts.branch
          : branchNameForDigest(run.candidateDigest);
      await openPr(root, opts.base ?? 'main', branch, reports, run, plan.changedFiles);
    }
  });

async function persistValidation(root: string, run: { candidateDigest: string }): Promise<void> {
  try {
    const dir = path.join(root, '.apimigrate');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `validation-${run.candidateDigest.slice(0, 12)}.json`);
    await fs.writeFile(file, JSON.stringify(run, null, 2), 'utf8');
    console.log(`evidence: ${path.relative(root, file)}`);
  } catch (err) {
    console.error(`warning: could not persist validation evidence: ${(err as Error).message}`);
  }
}

async function openPr(
  root: string,
  base: string,
  branch: string,
  reports: ScanReport[],
  run: { candidateDigest: string; baseSha: string | null; profileId: string },
  changedFiles: Map<string, string>,
) {
  // Delegate to GitHub CLI (gh) which handles auth. In production, the
  // GitHub App backend does this via the API.
  const { execSync, execFileSync } = await import('node:child_process');
  try {
    // FR-10 stale-state handling: the base, lockfile, or candidate may have
    // moved between validation and delivery. Recompute with the same binding
    // inputs and block instead of delivering stale validation as current.
    const nowBase = await getBaseSha(root);
    const nowLock = await getLockfileDigest(root);
    const { digest: nowDigest } = await computeCandidateDigest(changedFiles, reports, {
      profileId: run.profileId,
      baseSha: nowBase,
      lockfileDigest: nowLock,
    });
    const fresh = checkFreshness(
      { candidateDigest: run.candidateDigest, baseSha: run.baseSha },
      { digest: nowDigest, baseSha: nowBase },
    );
    if (!fresh.fresh) {
      console.error(
        `Stale candidate (${fresh.reason}); validation no longer applies. Re-run apply to revalidate.`,
      );
      process.exitCode = 1;
      return;
    }
    // Never overwrite an existing branch (user edits or prior run): resolve
    // a free name instead. Local existence check via git; no force operations.
    const exists = (b: string): boolean => {
      try {
        execFileSync('git', ['rev-parse', '--verify', `refs/heads/${b}`], { cwd: root, stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    };
    let head = branch;
    if (exists(head)) {
      const free = await resolveFreeBranch(head, async (b) => exists(b));
      console.log(`Branch ${head} exists; using ${free.branch} instead (existing ref untouched)`);
      head = free.branch;
    }
    execSync(`git switch -c ${head}`, { cwd: root, stdio: 'pipe' });
    execSync(`git add -A`, { cwd: root, stdio: 'pipe' });
    execSync(`git commit -m "chore(apimigrate): apply API migration"`, { cwd: root, stdio: 'pipe' });
    execSync(`git push -u origin ${head}`, { cwd: root, stdio: 'pipe' });
    const body = buildPrBody(reports, run.candidateDigest);
    execSync(`gh pr create --base ${base} --head ${head} --title "chore(apimigrate): apply API migration" --body "${body.replace(/"/g, '\\"')}"`, {
      cwd: root,
      stdio: 'pipe',
    });
    console.log(`PR opened: ${head} -> ${base}`);
  } catch (err) {
    console.error('Failed to open PR:', (err as Error).message);
    process.exitCode = 1;
  }
}

function buildPrBody(reports: ScanReport[], candidateDigest?: string): string {
  const lines: string[] = [
    '## Auto-generated API migration',
    '',
    'This PR was created by [apimigrate](https://github.com/apimigrate/apimigrate).',
    '',
    'It applies changes detected in the following manifests:',
    '',
  ];
  for (const report of reports) {
    lines.push(`### ${report.manifest.vendor}: ${report.manifest.title}`);
    lines.push('');
    lines.push(`Severity: **${report.manifest.severity}** — effective ${report.manifest.changedAt}`);
    if (report.manifest.references?.length) {
      lines.push('');
      lines.push('References: ' + report.manifest.references.join(', '));
    }
    lines.push('');
    lines.push(`Affected usages: **${report.hits.length}**`);
    lines.push('');
    lines.push('| File | Line | Kind | Status |');
    lines.push('| --- | --- | --- | --- |');
    for (const hit of report.hits.slice(0, 25)) {
      const status = hit.replacement && hit.replacement !== hit.snippet ? 'fixed' : 'manual';
      lines.push(`| ${hit.file} | ${hit.line} | ${hit.kind} | ${status} |`);
    }
    if (report.hits.length > 25) {
      lines.push(`| ... | | | ${report.hits.length - 25} more |`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('Review before merging. If something looks wrong, close this PR.');
  if (candidateDigest) {
    lines.push('');
    lines.push(`candidate: \`${candidateDigest.slice(0, 12)}\``);
  }
  return lines.join('\n');
}

function printReports(reports: ScanReport[], root: string) {
  if (reports.length === 0) {
    console.log(`No affected usages found in ${root}`);
    return;
  }
  let total = 0;
  for (const report of reports) {
    total += report.hits.length;
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${report.manifest.vendor}: ${report.manifest.title}`);
    console.log(`  severity: ${report.manifest.severity}  effective: ${report.manifest.changedAt}`);
    console.log(`  ${report.hits.length} hit(s) across ${report.filesScanned} file(s)`);
    console.log('  ' + '-'.repeat(66));
    for (const hit of report.hits.slice(0, 20)) {
      const status = hit.replacement && hit.replacement !== hit.snippet ? 'fixable' : 'manual';
      console.log(`  ${hit.file}:${hit.line}  [${status}] ${hit.snippet}`);
    }
    if (report.hits.length > 20) {
      console.log(`  ... and ${report.hits.length - 20} more`);
    }
  }
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Total affected usages: ${total}`);
}

program.parseAsync(process.argv);
