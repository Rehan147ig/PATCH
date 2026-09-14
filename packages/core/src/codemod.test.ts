import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanDirectory } from '../src/scanner.js';
import { planCodemods, writeCodemods } from '../src/codemod.js';
import type { MigrationManifest } from '../src/types.js';

const m = (): MigrationManifest => ({
  schemaVersion: '1.0',
  id: 'test',
  vendor: 'test',
  title: 't',
  severity: 'breaking',
  lang: 'typescript',
  changedAt: '2026-01-01',
  changes: [
    {
      type: 'renamed-call',
      description: 'rename',
      match: { call: { name: 'skus', object: 'stripe' } },
      fix: { kind: 'rename-call', from: 'stripe.skus', to: 'stripe.products' },
    },
  ],
});

describe('codemod', () => {
  it('plans a rename fix for a matched call', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'apimigrate-'));
    writeFileSync(
      path.join(dir, 'a.ts'),
      `const s = stripe.skus.list();
`,
    );
    const reports = await scanDirectory(dir, [m()]);
    const plan = planCodemods(reports, dir);
    expect(plan.replacements).toBeGreaterThan(0);
    const content = plan.changedFiles.get('a.ts');
    expect(content).toContain('stripe.products.list()');
    expect(content).not.toContain('stripe.skus');
  });

  it('writes changes to disk', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'apimigrate-'));
    writeFileSync(
      path.join(dir, 'a.ts'),
      `stripe.skus.retrieve('s');
`,
    );
    const reports = await scanDirectory(dir, [m()]);
    const plan = planCodemods(reports, dir);
    const written = await writeCodemods(plan, dir);
    expect(written).toContain('a.ts');
    const content = await import('node:fs').then((fs) => fs.promises.readFile(path.join(dir, 'a.ts'), 'utf8'));
    expect(content).toContain('stripe.products.retrieve');
  });

  it('leaves unmatched code untouched', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'apimigrate-'));
    writeFileSync(
      path.join(dir, 'a.ts'),
      `const x = something.else();
`,
    );
    const reports = await scanDirectory(dir, [m()]);
    const plan = planCodemods(reports, dir);
    expect(plan.changedFiles.size).toBe(0);
  });
});
