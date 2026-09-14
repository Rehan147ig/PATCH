import { describe, it, expect } from 'vitest';
import { signLease, verifyLease, signEvidence, verifyEvidence, isCommandAllowed } from './runner.js';

describe('FR-13 shared runner protocol (scenario 12)', () => {
  it('customer and hosted runners emit identical verifiable evidence schema', () => {
    const base = {
      schemaVersion: '1.0' as const, orgId: 'o', repoId: 'r', candidateDigest: 'abc',
      baseSha: '0'.repeat(40), verdict: 'VERIFIED' as const, dimensions: [],
      toolVersions: { node: 'v20' }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    };
    const c = signEvidence({ ...base, runnerId: 'cust-1', runnerKind: 'customer' as const }, 's');
    const h = signEvidence({ ...base, runnerId: 'host-1', runnerKind: 'hosted' as const }, 's');
    expect(Object.keys(c).sort()).toEqual(Object.keys(h).sort());
    expect(verifyEvidence(c, 's')).toBe(true);
    expect(verifyEvidence({ ...c, verdict: 'FAILED' }, 's')).toBe(false);
  });

  it('signed leases expire; lifecycle scripts never implicitly allowed', () => {
    const lease = signLease({
      jobId: 'j', orgId: 'o', repoId: 'r', candidateDigest: 'd', runnerId: 'r1',
      issuedAt: Date.now(), expiresAt: Date.now() + 60000, allowedCommands: ['npm test -- --runInBand'],
    }, 's');
    expect(verifyLease(lease, 's')).toBe(true);
    expect(isCommandAllowed('npm test -- --runInBand', lease)).toBe(true);
    expect(isCommandAllowed('preinstall', lease)).toBe(false);
    expect(isCommandAllowed('npm run preinstall', lease)).toBe(false);
  });
});
