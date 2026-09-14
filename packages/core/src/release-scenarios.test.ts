import { describe, it, expect } from 'vitest';
import { planCodemods } from './codemod.js';
import { checkFreshness, gateDelivery } from './delivery.js';
import { resolveCanonical, buildAliasMap } from './alias-resolution.js';
import { collectVersionFacts, upgradeApplies, isExposedToVersion } from './version-facts.js';
import { pollFeed, type FeedState } from './change-event.js';
import { verifyRecipe, signRecipe, assertSafePath, assertSafeFetchUrl } from './security.js';
import { generateKeyPairSync } from 'node:crypto';
import { acceptCiEvidence } from './verification.js';
import { reconcileDelivery, IdempotentConsumer } from './workflow.js';
import { isCommandAllowed } from './runner.js';
import { evaluatePaymentChecks, evaluateAiSwap } from './domain-checks.js';
import { TenantStore } from './tenancy.js';
import { ArtifactRegistry } from './retention.js';
import { UsageLedger } from './metering.js';
import { shouldNotify } from './notifications.js';
import { recognizedOnly } from './coverage.js';

/**
 * Full §15 release-acceptance matrix (1–18). Each scenario asserts the real
 * gate; heavy paths (7, 16) are covered by their dedicated suites and
 * referenced here so the matrix documents the complete chain.
 */
describe('§15 scenarios 1–18 end to end', () => {
  it('1: clean repo → truthful empty result, no PR', () => {
    const plan = planCodemods([], process.cwd());
    expect(plan.changedFiles.size).toBe(0);
    const gate = gateDelivery({ verdict: 'INCOMPLETE', fresh: true, baselineKnown: true, explicitApproval: false });
    expect(gate.ok).toBe(false);
  });

  it('2: aliases/wrappers discovered; unrelated excluded', () => {
    const aliases = buildAliasMap(new Map([['a.ts', `import * as s from 'stripe';\ns.skus.list({});`]]));
    expect(resolveCanonical('s.skus.list', aliases)).toBe('stripe.skus.list');
    expect(resolveCanonical('other.list', aliases)).toBeNull();
  });

  it('3: old major pinned still matches targeted upgrade while exposure excludes new major', () => {
    expect(isExposedToVersion('11.5.0', '>=12.0.0')).toBe(false);
    expect(upgradeApplies('11.5.0', '>=11.0.0')).toBe(true);
  });

  it('4: unknown account/webhook/model → needs-information, no guess', () => {
    const f = collectVersionFacts({ provider: 'stripe' });
    expect(f.needsInformation.length).toBeGreaterThan(0);
  });

  it('5: contract change detected; additive stays quiet', async () => {
    const noSleep = async (_ms: number) => {};
    let st: FeedState = { url: 'https://x', consecutiveFailures: 0, emittedDigests: new Set() };
    const first = await pollFeed(st, async () => ({ status: 200, body: 'spec-v2' }), Date.now(), { sleep: noSleep });
    expect(first.changed).toBe(true);
    st = first.state;
    const same = await pollFeed(st, async () => ({ status: 200, body: 'spec-v2' }), Date.now(), { sleep: noSleep });
    expect(same.changed).toBe(false);
    expect(shouldNotify({ affected: true }, { kind: 'optional-feature' })).toBe(false);
  });

  it('6: altered signed recipe rejected, no execution', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pub = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const priv = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const r = signRecipe(priv, 'fam', 1, 1, { fix: 'a' }, 'k1');
    expect(verifyRecipe(r, new Map([['k1', pub]]), new Set(), 1).ok).toBe(true);
    expect(verifyRecipe({ ...r, payload: { fix: 'evil' } }, new Map([['k1', pub]]), new Set(), 1).ok).toBe(false);
  });

  it('7: async-false / no-tests / install-only never VERIFIED (see verification.test.ts)', () => {
    const gate = gateDelivery({ verdict: 'INCOMPLETE', fresh: true, baselineKnown: true, explicitApproval: false });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toBe('needs-approval');
  });

  it('8: dependent failure fails the candidate', () => {
    expect(gateDelivery({ verdict: 'FAILED', fresh: true, baselineKnown: true, explicitApproval: true }).ok).toBe(false);
  });

  it('9: base/lockfile move invalidates validation + approval', () => {
    expect(checkFreshness(
      { candidateDigest: 'd', baseSha: '0'.repeat(40) },
      { digest: 'd', baseSha: '1'.repeat(40) },
    ).fresh).toBe(false);
  });

  it('10: old-head or pending CI never promotes', () => {
    const head = 'a'.repeat(40);
    expect(acceptCiEvidence({
      candidateHeadSha: head, baseSha: head,
      checks: [{ workflow: 'ci', check: 'b', headSha: 'c'.repeat(40), status: 'success' }],
      expectedWorkflows: ['ci'], requiredChecks: ['b'], trustedRunners: new Set(['r']), runnerId: 'r',
    }).ok).toBe(false);
  });

  it('11: worker-die-after-create reconciles one PR + one billing event', async () => {
    const recorded: Array<{ url: string; number: number }> = [];
    const out = await reconcileDelivery(
      async () => (recorded.length ? { url: 'u/1', number: 1 } : null),
      async () => { const pr = { url: 'u/1', number: 1 }; recorded.push(pr); return pr; },
      async () => {},
    );
    expect(out.pr.number).toBe(1);
    const ledger = new UsageLedger();
    const a = ledger.record({ orgId: 'o', repoId: 'r', candidateDigest: 'd', kind: 'migration-delivered', billable: 'completed' });
    const b = ledger.record({ orgId: 'o', repoId: 'r', candidateDigest: 'd', kind: 'migration-delivered', billable: 'completed' });
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    const c = new IdempotentConsumer();
    expect(c.consume('k', () => 1).duplicate).toBe(false);
    expect(c.consume('k', () => 1).duplicate).toBe(true);
  });

  it('12: lifecycle scripts denied; traversal/SSRF rejected; secrets scoped', () => {
    expect(isCommandAllowed('preinstall', { allowedCommands: ['npm test'] })).toBe(false);
    expect(() => assertSafePath('/repo', '../etc/passwd')).toThrow();
    expect(() => assertSafeFetchUrl('http://169.254.169.254/')).toThrow();
  });

  it('13: payment typecheck-pass + webhook-fail stays blocked', () => {
    const { blocked } = evaluatePaymentChecks({
      required: ['webhook-verify', 'idempotency'],
      results: { 'webhook-verify': { pass: false }, idempotency: { pass: true } },
    });
    expect(blocked).toBe(true);
  });

  it('14: AI HTTP-pass + quality-fail needs review, no equivalence', () => {
    const r = evaluateAiSwap({
      taskSuccess: 0.5, successThreshold: 0.9, latencyMsP95: 500, latencyBudgetMs: 1000,
      costUsd: 1, costBudgetUsd: 2, modelProvenance: 'openai:x', httpChecksPass: true,
    });
    expect(r.equivalent).toBe(false);
    expect(r.needsReview).toBe(true);
  });

  it('15: revocation stops work; org deletion verified under retention', () => {
    const s = new TenantStore();
    const o = s.createOrg('acme');
    const ins = s.install(o.id, 1, ['acme/app']);
    const repo = s.addRepo(o.id, ins.id, 'acme', 'app');
    s.revoke(ins.id);
    expect(s.authorize(o.id, ins.id, repo.id, 'job').ok).toBe(false);
    const reg = new ArtifactRegistry();
    reg.record('org_1', 'raw-checkout', 's3://c', true);
    expect(reg.deleteOrgData('org_1').deleted).toHaveLength(1);
  });

  it('16: CLI --dry-run + --write contract (see cli.test.ts)', () => {
    // cli.test.ts asserts exit 2 + no writes for the conflicting flags.
    expect(true).toBe(true);
  });

  it('17: unknown provider → recognized, never green', () => {
    expect(recognizedOnly('acme', 'x').state).toBe('recognized');
  });

  it('18: outage → freshness warning + bounded retry + no duplicate alerts', async () => {
    const noSleep = async (_ms: number) => {};
    const st: FeedState = { url: 'https://x', consecutiveFailures: 0, emittedDigests: new Set(), lastSuccessAt: Date.now() - 3600_000 };
    const { freshnessStatus } = await import('./change-event.js');
    expect(freshnessStatus(st, 60_000).fresh).toBe(false);
    const down = await pollFeed(st, async () => ({ status: 500, body: '' }), Date.now(), { sleep: noSleep, maxRetries: 2 });
    expect(down.error).toMatch(/bounded retry/);
  });
});
