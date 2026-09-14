import { describe, it, expect } from 'vitest';
import { createReviewTask, RepoIndex, chooseStrategy } from './pipeline.js';
import { classifyCoverage, recognizedOnly } from './coverage.js';
import { TenantQuota, RateLimiter, SloTracker, evaluateCorpus, totalCost } from './ops.js';
import { UNDECIDED_CONFIG, isConfigured, testAdapterConfig } from './config.js';

describe('§5 review tasks (§5 unknown/contradictory → task)', () => {
  it('creates a bounded review task, never silent', () => {
    const t = createReviewTask('org_1', 'contradictory-evidence', 'SDK says v2, spec says v3', ['https://a', 'https://b'], 'repo_1');
    expect(t.sourceRefs).toHaveLength(2);
    expect(t.resolvedAt).toBeNull();
  });
});

describe('§6 incremental index + invalidation', () => {
  it('invalidates on commit/extractor/manifest/lockfile/compiler/traversal signals', () => {
    const idx = new RepoIndex();
    idx.index('r', { commitSha: 'a'.repeat(40), extractorVersion: 'e1' });
    const same = idx.check('r', { commitSha: 'a'.repeat(40), extractorVersion: 'e1' }, {});
    expect(same.invalidated).toBe(false);
    const moved = idx.check('r', { commitSha: 'b'.repeat(40), extractorVersion: 'e1' }, { manifestDigest: 'm2', knownManifestDigest: 'm1', traversalLimited: true });
    expect(moved.invalidated).toBe(true);
    expect(moved.reasons.join(';')).toMatch(/commit moved|manifest changed|full scan/);
  });
});

describe('§7 strategy order + LLM guardrails', () => {
  it('prefers official codemod, then transform, then bounded agent, then plan-only', () => {
    expect(chooseStrategy({ hasOfficialCodemod: true, official: { artifact: 'a', digest: 'd', license: 'MIT', provenance: 'vendor' }, hasQualifiedTransform: true, agentAllowed: true, safelyAutomatable: true }).strategy).toBe('official-codemod');
    expect(chooseStrategy({ hasOfficialCodemod: false, hasQualifiedTransform: true, agentAllowed: true, safelyAutomatable: true }).strategy).toBe('patch-transform');
    const agent = chooseStrategy({ hasOfficialCodemod: false, hasQualifiedTransform: false, agentAllowed: true, safelyAutomatable: true });
    expect(agent.strategy).toBe('external-agent');
    expect(agent.agentBounds).toMatchObject({ allowShell: false, allowSelfApprove: false });
    expect(chooseStrategy({ hasOfficialCodemod: false, hasQualifiedTransform: false, agentAllowed: false, safelyAutomatable: false }).strategy).toBe('plan-only');
  });
});

describe('coverage honesty (G3)', () => {
  it('qualifies only listed slices; anthropic/gemini stay monitored; unknown stays recognized', () => {
    const cov = classifyCoverage([
      { schemaVersion: '1.0', id: 'openai-v1-chat-completions', vendor: 'openai', title: 't', severity: 'deprecation', lang: 'typescript', changedAt: '2024-01-01', changes: [] },
      { schemaVersion: '1.0', id: 'anthropic-messages-lifecycle', vendor: 'anthropic', title: 't', severity: 'deprecation', lang: 'typescript', changedAt: '2026-03-01', changes: [] },
    ]);
    expect(cov.find((c) => c.provider === 'openai')?.state).toBe('maintained');
    expect(cov.find((c) => c.provider === 'anthropic')?.state).toBe('monitored');
    expect(recognizedOnly('acme', 'acme.widgets.list').state).toBe('recognized');
  });
});

describe('§12 quotas/rate/SLO + §13 eval/cost', () => {
  it('enforces fair quotas visibly, rate-limits, tracks p95, evaluates with denominators', () => {
    const q = new TenantQuota({ maxConcurrentJobs: 1, maxRepos: 10, maxScansPerHour: 10 });
    expect(q.tryStart('o').ok).toBe(true);
    expect(q.tryStart('o').ok).toBe(false);
    q.finish('o');
    expect(q.tryStart('o').ok).toBe(true);

    const rl = new RateLimiter(2, 1);
    expect(rl.tryTake()).toBe(true);
    expect(rl.tryTake()).toBe(true);
    expect(rl.tryTake()).toBe(false);

    const slo = new SloTracker();
    for (let i = 1; i <= 100; i++) slo.record('api-read-ms', i);
    expect(slo.p95('api-read-ms')).toBe(96);

    const cases = Array.from({ length: 40 }, (_, i) => ({
      id: `p${i}`, changeFamily: 'f', expectedAffected: true, predictedAffected: i < 38,
      expectedInstance: true, predictedInstance: i < 39,
    })).concat(Array.from({ length: 35 }, (_, i) => ({
      id: `n${i}`, changeFamily: 'f', expectedAffected: false, predictedAffected: i < 1,
      expectedInstance: false, predictedInstance: false,
    })));
    const evalResult = evaluateCorpus(cases, 5, 20);
    expect(evalResult.meetsMinimums).toBe(true);
    expect(evalResult.impactPrecision).toBeGreaterThan(0.95);
    expect(totalCost({ modelUsd: 1, runnerUsd: 2, fetchUsd: 0.5, storageUsd: 0.5, supportUsd: 1, retriesUsd: 0 })).toBe(5);
  });
});

describe('§16 config honesty', () => {
  it('reports missing owner decisions; test adapter never claims production', () => {
    expect(isConfigured(UNDECIDED_CONFIG).configured).toBe(false);
    expect(isConfigured(UNDECIDED_CONFIG).missing).toContain('productionRegion');
    expect(testAdapterConfig().testAdapter).toBe(true);
  });
});
