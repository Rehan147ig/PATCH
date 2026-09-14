#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import {
  loadManifests,
  scanDirectory,
  planCodemods,
  writeCodemods,
  verifyBuild,
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
  .option('--branch <name>', 'branch name for the PR', 'apimigrate/auto-migration')
  .option('--dry-run', 'plan changes without writing or pushing')
  .action(async (dir: string, opts: { manifests: string; pr?: boolean; base?: string; branch?: string; dryRun?: boolean }) => {
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
      return;
    }

    const written = await writeCodemods(plan, root);
    if (written.length === 0) {
      console.log('No changes to apply');
      return;
    }
    console.log(`Wrote ${written.length} file(s)`);

    const failing = await verifyBuild(root);
    if (failing.length > 0) {
      console.error(`Build verification failed in ${failing.length} file(s):`);
      for (const f of failing) console.error(`  - ${f}`);
      console.error('PR not opened; inspect the diff before committing.');
      process.exitCode = 1;
      return;
    }
    console.log('Build verification passed');

    if (opts.pr) {
      await openPr(root, opts.base!, opts.branch!, reports);
    }
  });

async function openPr(root: string, base: string, branch: string, reports: ScanReport[]) {
  // Delegate to GitHub CLI (gh) which handles auth. In production, the
  // GitHub App backend does this via the API.
  const { execSync } = await import('node:child_process');
  try {
    execSync(`git switch -c ${branch}`, { cwd: root, stdio: 'pipe' });
    execSync(`git add -A`, { cwd: root, stdio: 'pipe' });
    execSync(`git commit -m "chore(apimigrate): apply API migration"`, { cwd: root, stdio: 'pipe' });
    execSync(`git push -u origin ${branch}`, { cwd: root, stdio: 'pipe' });
    const body = buildPrBody(reports);
    execSync(`gh pr create --base ${base} --head ${branch} --title "chore(apimigrate): apply API migration" --body "${body.replace(/"/g, '\\"')}"`, {
      cwd: root,
      stdio: 'pipe',
    });
    console.log(`PR opened: ${branch} -> ${base}`);
  } catch (err) {
    console.error('Failed to open PR:', (err as Error).message);
    process.exitCode = 1;
  }
}

function buildPrBody(reports: ScanReport[]): string {
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
