import { describe, it, expect } from 'vitest';
import { checkPolicy, classifySensitivity, type Policy } from './policy.js';

const policy: Policy = {
  orgId: 'org_1', sensitiveApprovers: ['customer:payments-owner'],
  requireTwoPersonForSensitive: false, externalDataAuthorities: ['customer:platform'],
  requireCustomerAuthorization: true,
};

describe('FR-09 candidate-bound policy', () => {
  it('rejects stale-digest approvals and recipe-only authorization', () => {
    const r1 = checkPolicy(policy, 'new-digest', [{ candidateDigest: 'old-digest', approver: 'a', authority: 'customer:payments-owner', createdAt: '' }], 'sensitive-payment');
    expect(r1.ok).toBe(false);
    const r2 = checkPolicy(policy, 'd', [{ candidateDigest: 'd', approver: 'vendor', authority: 'public-recipe', createdAt: '' }], 'standard');
    expect(r2.ok).toBe(false);
  });

  it('requires configured authority for payment/auth; two-person when enabled', () => {
    expect(classifySensitivity({ touchesPayments: true })).toBe('sensitive-payment');
    const ok = checkPolicy(policy, 'd', [{ candidateDigest: 'd', approver: 'p', authority: 'customer:payments-owner', createdAt: '' }], 'sensitive-payment');
    expect(ok.ok).toBe(true);
    const strict: Policy = { ...policy, requireTwoPersonForSensitive: true };
    const one = checkPolicy(strict, 'd', [{ candidateDigest: 'd', approver: 'p', authority: 'customer:payments-owner', createdAt: '' }], 'sensitive-payment');
    expect(one.ok).toBe(false);
  });
});
