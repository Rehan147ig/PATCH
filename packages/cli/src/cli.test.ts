import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanDirectory, planCodemods } from '@apimigrate/core';

describe('cli integration', () => {
  it('scans a repo with a manifest and finds the affected call', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'apimigrate-cli-'));
    writeFileSync(
      path.join(dir, 'index.ts'),
      `import Stripe from 'stripe';
const stripe = new Stripe('sk_test');
await stripe.charges.create({ amount: 1000 });
`,
    );
    const manifest = {
      schemaVersion: '1.0' as const,
      id: 'cli-test',
      vendor: 'stripe',
      title: 't',
      severity: 'breaking' as const,
      lang: 'typescript',
      changedAt: '2026-01-01',
      changes: [
        {
          type: 'renamed-call' as const,
          description: 'd',
          match: { call: { name: 'charges.create', object: 'stripe' } },
        },
      ],
    };
    const reports = await scanDirectory(dir, [manifest]);
    expect(reports).toHaveLength(1);
    expect(reports[0].hits.some((h) => h.snippet.includes('stripe.charges.create'))).toBe(true);
  });

  it('plans a fix that rewrites stripe.skus to stripe.products', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'apimigrate-cli2-'));
    writeFileSync(path.join(dir, 'a.ts'), `const s = stripe.skus.list();\n`);
    const manifest = {
      schemaVersion: '1.0' as const,
      id: 'cli-test',
      vendor: 'stripe',
      title: 't',
      severity: 'breaking' as const,
      lang: 'typescript',
      changedAt: '2026-01-01',
      changes: [
        {
          type: 'renamed-call' as const,
          description: 'd',
          match: { call: { name: 'skus', object: 'stripe' } },
          fix: { kind: 'rename-call' as const, from: 'stripe.skus', to: 'stripe.products' },
        },
      ],
    };
    const reports = await scanDirectory(dir, [manifest]);
    const plan = planCodemods(reports, dir);
    const content = plan.changedFiles.get('a.ts');
    expect(content).toContain('stripe.products.list()');
  });

  it('--dry-run plus --write is an explicit argument error with no writes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'apimigrate-cli-flags-'));
    const before = `const s = stripe.skus.list();\n`;
    writeFileSync(path.join(dir, 'a.ts'), before);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'flag-test' }));
    const mdir = mkdtempSync(path.join(tmpdir(), 'apimigrate-manifests-'));
    writeFileSync(
      path.join(mdir, 'm.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        id: 'flag-test',
        vendor: 'stripe',
        title: 't',
        severity: 'deprecation',
        lang: 'typescript',
        changedAt: '2026-01-01',
        changes: [
          {
            type: 'deprecated-call',
            description: 'd',
            match: { call: { name: 'skus', object: 'stripe' } },
            fix: { kind: 'rename-call', from: 'stripe.skus', to: 'stripe.products' },
          },
        ],
      }),
    );
    const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    expect(existsSync(cliPath), 'built CLI dist exists').toBe(true);
    const result = await new Promise<{ code: number; out: string; err: string }>((resolve) => {
      execFile(
        process.execPath,
        [cliPath, 'apply', dir, '--manifests', mdir, '--dry-run', '--write'],
        { timeout: 30000 },
        (err, stdout, stderr) => {
          resolve({
            code: (err as { code?: number } | null)?.code ?? 0,
            out: String(stdout ?? ''),
            err: String(stderr ?? ''),
          });
        },
      );
    });
    expect(result.code).not.toBe(0);
    expect(result.out + result.err).toMatch(/mutually exclusive/i);
    // No writes: source untouched, no evidence dir.
    expect(readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe(before);
    expect(existsSync(path.join(dir, '.apimigrate'))).toBe(false);
  }, 60000);
});
