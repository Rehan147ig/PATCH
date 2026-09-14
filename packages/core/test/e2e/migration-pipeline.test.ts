import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanDirectory } from '../../src/scanner.js';
import { planCodemods } from '../../src/codemod.js';
import { verifyCandidate, computeCandidateDigest } from '../../src/verification.js';
import type { MigrationManifest } from '../../src/types.js';

/**
 * Golden E2E: scan -> plan codemod -> dry-run -> verify.
 *
 * Fixture is a minimal Stripe-using repo with a known deprecated call
 * (`stripe.skus.list`). The pipeline must detect it, plan a mechanical
 * rename to `stripe.products.list`, prove dry-run makes zero filesystem
 * writes, and verify the candidate with recorded diagnostics.
 */
describe('golden e2e migration pipeline (scan -> plan -> dry-run -> verify)', () => {
  it('migrates stripe.skus to stripe.products end-to-end', async () => {
    // ---- Fixture setup ----
    const dir = mkdtempSync(path.join(tmpdir(), 'apimigrate-e2e-'));
    const original = [
      'declare const stripe: any;',
      'async function main() {',
      '  const skus = await stripe.skus.list({ limit: 10 });',
      '  return skus;',
      '}',
      'export { main };',
      '',
    ].join('\n');
    writeFileSync(path.join(dir, 'app.ts'), original);
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify(
        {
          name: 'e2e-fixture',
          version: '1.0.0',
          dependencies: {},
          scripts: { test: 'node -e "process.exit(0)"' },
        },
        null,
        2,
      ),
    );
    const manifest: MigrationManifest = {
      schemaVersion: '1.0',
      id: 'stripe-2025-03-sku-deprecation',
      vendor: 'stripe',
      title: 'SKU API deprecated',
      severity: 'deprecation',
      lang: 'typescript',
      changedAt: '2025-03-01',
      changes: [
        {
          type: 'deprecated-call',
          description: 'stripe.skus is deprecated; migrate to stripe.products.',
          match: { call: { name: 'skus', object: 'stripe' } },
          fix: { kind: 'rename-call', from: 'stripe.skus', to: 'stripe.products' },
        },
      ],
    };

    // ---- Step 1 (Scan) ----
    const reports = await scanDirectory(dir, [manifest]);
    expect(reports).toHaveLength(1);
    expect(reports[0].manifest.severity).toBe('deprecation');
    expect(reports[0].manifest.id).toBe('stripe-2025-03-sku-deprecation');
    expect(reports[0].hits).toHaveLength(1);
    const hit = reports[0].hits[0];
    expect(hit.file).toBe('app.ts');
    expect(hit.line).toBe(3);
    expect(hit.snippet).toContain('stripe.skus');
    expect(hit.kind).toBe('deprecated-call');

    // ---- Step 2 (Plan codemod) ----
    const plan = planCodemods(reports, dir);
    expect(plan.replacements).toBeGreaterThan(0);
    expect(plan.changedFiles.has('app.ts')).toBe(true);
    const migrated = plan.changedFiles.get('app.ts')!;
    // Replacement AST edit: exact symbol rename, prefix-aware.
    expect(migrated).toContain('stripe.products.list');
    expect(migrated).not.toContain('stripe.skus');
    // Recipe binding: fix declares the versioned from -> to migration.
    expect(hit.fix?.from).toBe('stripe.skus');
    expect(hit.fix?.to).toBe('stripe.products');
    expect(hit.replacement).toBe('stripe.products.list');

    // ---- Step 3 (Dry-run safety) ----
    const diff = formatDiff(original, migrated, 'app.ts');
    expect(diff).toContain('-');
    expect(diff).toContain('+');
    expect(diff).toContain('stripe.skus');
    expect(diff).toContain('stripe.products');
    // Crucial: zero filesystem modifications on dry-run (plan only, no write).
    expect(readFileSync(path.join(dir, 'app.ts'), 'utf8')).toBe(original);
    expect(existsSync(path.join(dir, '.apimigrate'))).toBe(false);
    const entries = readdirSync(dir).sort();
    expect(entries).toEqual(['app.ts', 'package.json']);
    // Candidate binding is stable for the same inputs.
    const { digest } = await computeCandidateDigest(plan.changedFiles, reports);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    // ---- Step 4 (Verify output) ----
    const run = await verifyCandidate(dir, plan.changedFiles, reports, { timeoutMs: 60000 });
    expect(run.candidateDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(run.dimensions).toHaveLength(3);
    for (const d of run.dimensions) {
      expect(typeof d.exitCode === 'number' || d.exitCode === undefined).toBe(true);
      expect(d.reason.length).toBeGreaterThan(0);
    }
    const byName = new Map(run.dimensions.map((d) => [d.name, d]));
    expect(byName.get('dependency-resolution')?.exitCode).toBe(0);
    expect(byName.get('dependency-resolution')?.status).toBe('PASS');
    expect(byName.get('types-build')?.exitCode).toBe(0);
    expect(byName.get('types-build')?.status).toBe('PASS');
    expect(byName.get('unit-tests')?.exitCode).toBe(0);
    expect(byName.get('unit-tests')?.status).toBe('PASS');
    expect(run.verdict).toBe('VERIFIED');
    expect(run.fileCount).toBe(1);
  }, 120000);
});

function formatDiff(before: string, after: string, file: string): string {
  const b = before.split('\n');
  const a = after.split('\n');
  const lines = [`diff -- apimigrate dry-run ${file}`];
  const max = Math.max(b.length, a.length);
  for (let i = 0; i < max; i++) {
    if (b[i] !== a[i]) {
      if (i < b.length) lines.push(`- ${b[i]}`);
      if (i < a.length) lines.push(`+ ${a[i]}`);
    } else {
      lines.push(`  ${b[i]}`);
    }
  }
  return lines.join('\n');
}
