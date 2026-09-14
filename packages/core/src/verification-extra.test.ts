import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeCandidateDigest, verifyCandidate, acceptCiEvidence, validationProfileDigest } from './verification.js';

function mkdir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'verify-extra-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('§7 full candidate binding + §8 eight dimensions + CI gate', () => {
  it('binding changes with org/repo/source-event/profile-digest; legacy nulls stay stable', async () => {
    const files = new Map([['a.ts', 'hello']]);
    const base = (await computeCandidateDigest(files, [])).digest;
    const same = (await computeCandidateDigest(files, [])).digest;
    expect(base).toBe(same);
    expect((await computeCandidateDigest(files, [], { orgId: 'org_1' })).digest).not.toBe(base);
    expect((await computeCandidateDigest(files, [], { repoId: 'repo_1' })).digest).not.toBe(base);
    expect((await computeCandidateDigest(files, [], { sourceEventDigest: 'ev1' })).digest).not.toBe(base);
    expect(validationProfileDigest({ id: 'default-v1', required: ['unit-tests'] })).toMatch(/^[0-9a-f]{12}$/);
  });

  it('all eight dimensions are explicit; required-but-missing blocks VERIFIED', async () => {
    const dir = mkdir({ 'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }), 'a.ts': 'export const x = 1;\n' });
    const run = await verifyCandidate(dir, new Map([['a.ts', 'export const x = 1;\n']]), [], { timeoutMs: 60000 });
    const names = run.dimensions.map((d) => d.name).sort();
    expect(names).toEqual(['contract-sandbox', 'customer-acceptance', 'dependency-resolution', 'domain-behavior', 'integration-tests', 'syntax', 'types-build', 'unit-tests'].sort());
    for (const d of run.dimensions) expect(['PASS', 'FAIL', 'NOT_RUN', 'NOT_APPLICABLE', 'INCONCLUSIVE']).toContain(d.status);

    const strict = await verifyCandidate(dir, new Map([['a.ts', 'export const x = 1;\n']]), [], {
      timeoutMs: 60000,
      profile: { id: 'strict-v1', required: ['dependency-resolution', 'types-build', 'unit-tests', 'contract-sandbox'] },
    });
    expect(strict.verdict).toBe('INCOMPLETE');
    expect(strict.dimensions.find((d) => d.name === 'contract-sandbox')?.status).toBe('NOT_RUN');
  }, 90000);

  it('CI evidence: only current head + expected workflows + trusted runner + full matrix promotes', () => {
    const head = 'a'.repeat(40);
    const ok = acceptCiEvidence({
      candidateHeadSha: head, baseSha: head,
      checks: [{ workflow: 'ci', check: 'build', headSha: head, status: 'success' }],
      expectedWorkflows: ['ci'], requiredChecks: ['build'],
      trustedRunners: new Set(['r1']), runnerId: 'r1',
    });
    expect(ok.ok).toBe(true);
    expect(acceptCiEvidence({
      candidateHeadSha: head, baseSha: head,
      checks: [{ workflow: 'ci', check: 'build', headSha: 'b'.repeat(40), status: 'success' }],
      expectedWorkflows: ['ci'], requiredChecks: ['build'],
      trustedRunners: new Set(['r1']), runnerId: 'r1',
    }).ok).toBe(false);
    expect(acceptCiEvidence({
      candidateHeadSha: head, baseSha: head,
      checks: [{ workflow: 'ci', check: 'build', headSha: head, status: 'pending' }],
      expectedWorkflows: ['ci'], requiredChecks: ['build'],
      trustedRunners: new Set(['r1']), runnerId: 'r1',
    }).ok).toBe(false);
    expect(acceptCiEvidence({
      candidateHeadSha: head, baseSha: head,
      checks: [{ workflow: 'evil', check: 'build', headSha: head, status: 'success' }],
      expectedWorkflows: ['ci'], requiredChecks: ['build'],
      trustedRunners: new Set(['r1']), runnerId: 'r1',
    }).ok).toBe(false);
    expect(acceptCiEvidence({
      candidateHeadSha: head, baseSha: head, checks: [],
      expectedWorkflows: ['ci'], requiredChecks: ['build'],
      trustedRunners: new Set(['r1']), runnerId: 'r1',
    }).ok).toBe(false);
  });
});
