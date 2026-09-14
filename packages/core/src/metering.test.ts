import { describe, it, expect } from 'vitest';
import { UsageLedger } from './metering.js';

describe('FR-15 idempotent metering (scenario 11)', () => {
  it('retry after worker death bills once', () => {
    const l = new UsageLedger();
    const first = l.record({ orgId: 'o', repoId: 'r', candidateDigest: 'abc', kind: 'migration-delivered', billable: 'completed' });
    const retry = l.record({ orgId: 'o', repoId: 'r', candidateDigest: 'abc', kind: 'migration-delivered', billable: 'completed' });
    expect(first.duplicate).toBe(false);
    expect(retry.duplicate).toBe(true);
    expect(l.billableCount()).toBe(1);
  });

  it('PATCH-attributable failures are not billable completed outcomes', () => {
    const l = new UsageLedger();
    l.record({ orgId: 'o', repoId: 'r', candidateDigest: 'x', kind: 'verification-run', billable: 'non-billable', reason: 'patch-failure' });
    expect(l.billableCount()).toBe(0);
    expect(l.forOrg('o')[0].reason).toBe('patch-failure');
  });
});
