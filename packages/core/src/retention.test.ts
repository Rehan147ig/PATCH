import { describe, it, expect } from 'vitest';
import { ArtifactRegistry, DEFAULT_RETENTION } from './retention.js';

describe('FR-14 retention and export', () => {
  it('enforces default TTLs: checkout 1h, evidence 30d, audit 90d', () => {
    expect(DEFAULT_RETENTION.rawCheckoutTtlMs).toBe(3600000);
    expect(DEFAULT_RETENTION.evidenceTtlMs).toBe(30 * 86400000);
    expect(DEFAULT_RETENTION.auditTtlMs).toBe(90 * 86400000);
  });

  it('inventories retained artifacts and verifies deletion', () => {
    const r = new ArtifactRegistry();
    const a = r.record('org_1', 'raw-checkout', 's3://bucket/checkout-1', true);
    r.record('org_1', 'audit-metadata', 'db:audit:1', false);
    expect(r.inventory('org_1')).toHaveLength(2);
    const verified = r.verifyDeletion([a.id]);
    expect(verified).toEqual([a.id]);
    expect(r.inventory('org_1')).toHaveLength(1);
  });

  it('audit records must not silently retain code', () => {
    const r = new ArtifactRegistry();
    expect(() => r.record('org_1', 'audit-metadata', 'db:audit:x', true)).toThrow();
  });

  it('org deletion removes code but retains minimal audit metadata (scenario 15)', () => {
    const r = new ArtifactRegistry();
    r.record('org_1', 'raw-checkout', 's3://c', true);
    r.record('org_1', 'evidence', 's3://e', false);
    const audit = r.record('org_1', 'audit-metadata', 'db:audit:1', false);
    const res = r.deleteOrgData('org_1');
    expect(res.retainedAudit).toEqual([audit.id]);
    expect(r.inventory('org_1').map((a) => a.id)).toEqual([audit.id]);
  });
});
