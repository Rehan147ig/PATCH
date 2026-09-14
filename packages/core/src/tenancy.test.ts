import { describe, it, expect } from 'vitest';
import { TenantStore } from './tenancy.js';

describe('FR-01 two-tenant isolation + revocation (scenario 15)', () => {
  it('isolates repos across tenants', () => {
    const s = new TenantStore();
    const a = s.createOrg('acme');
    const b = s.createOrg('globex');
    const ia = s.install(a.id, 111, ['acme/app']);
    const ib = s.install(b.id, 222, ['globex/app']);
    const ra = s.addRepo(a.id, ia.id, 'acme', 'app');
    s.addRepo(b.id, ib.id, 'globex', 'app');
    expect(s.listRepos(a.id).map((r) => r.id)).toEqual([ra.id]);
    expect(s.listRepos(b.id)).toHaveLength(1);
    // Cross-tenant authorize fails.
    expect(s.authorize(b.id, ib.id, ra.id, 'scan').ok).toBe(false);
    expect(s.authorize(a.id, ia.id, ra.id, 'scan').ok).toBe(true);
  });

  it('revoked installation stops fetch, jobs, and PR delivery', () => {
    const s = new TenantStore();
    const o = s.createOrg('acme');
    const ins = s.install(o.id, 111, ['acme/app']);
    const repo = s.addRepo(o.id, ins.id, 'acme', 'app');
    for (const kind of ['fetch', 'scan', 'job', 'pr'] as const) {
      expect(s.authorize(o.id, ins.id, repo.id, kind).ok).toBe(true);
    }
    s.revoke(ins.id);
    for (const kind of ['fetch', 'scan', 'job', 'pr'] as const) {
      const d = s.authorize(o.id, ins.id, repo.id, kind);
      expect(d.ok).toBe(false);
      expect(d.reason).toBe('revoked');
    }
  });

  it('org deletion stops work (scenario 15)', () => {
    const s = new TenantStore();
    const o = s.createOrg('acme');
    const ins = s.install(o.id, 111, ['acme/app']);
    const repo = s.addRepo(o.id, ins.id, 'acme', 'app');
    s.deleteOrg(o.id);
    expect(s.authorize(o.id, ins.id, repo.id, 'scan').ok).toBe(false);
    expect(s.listRepos(o.id)).toHaveLength(1); // inventory retained until retention verifies deletion
  });

  it('read-only installation denies PR delivery but allows scan', () => {
    const s = new TenantStore();
    const o = s.createOrg('acme');
    const ins = s.install(o.id, 111, ['acme/app'], true);
    const repo = s.addRepo(o.id, ins.id, 'acme', 'app');
    expect(s.authorize(o.id, ins.id, repo.id, 'scan').ok).toBe(true);
    expect(s.authorize(o.id, ins.id, repo.id, 'pr').ok).toBe(false);
  });
});
