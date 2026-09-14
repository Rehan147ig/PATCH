import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
});
