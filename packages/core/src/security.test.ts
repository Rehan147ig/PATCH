import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  signRecipe, verifyRecipe, assertSafePath, assertSafeFetchUrl,
  assertSafeSpecSize, assertSafeCandidate,
} from './security.js';

function keys(): { pub: string; priv: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    pub: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    priv: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
}

describe('security guards + signed recipes (scenarios 6, 12)', () => {
  it('rejects altered recipes with evidence; enforces rotation + anti-rollback', () => {
    const { pub, priv } = keys();
    const pinned = new Map([['k1', pub]]);
    const r = signRecipe(priv, 'stripe-sku', 3, 7, { fix: 'rename' }, 'k1');
    expect(verifyRecipe(r, pinned, new Set(), 7).ok).toBe(true);
    expect(verifyRecipe({ ...r, payload: { fix: 'evil' } }, pinned, new Set(), 7).ok).toBe(false);
    expect(verifyRecipe(r, pinned, new Set(['k1']), 7).ok).toBe(false);
    expect(verifyRecipe(r, pinned, new Set(), 8).ok).toBe(false);
    expect(verifyRecipe(r, new Map(), new Set(), 0).ok).toBe(false);
  });

  it('rejects traversal, SSRF, bombs, oversized candidates', () => {
    expect(() => assertSafePath('/repo', '../etc/passwd')).toThrow();
    expect(() => assertSafePath('/repo', '/abs')).toThrow();
    assertSafePath('/repo', 'src/a.ts');
    expect(() => assertSafeFetchUrl('http://169.254.169.254/latest')).toThrow();
    expect(() => assertSafeFetchUrl('https://user:pass@vendor.com/x')).toThrow();
    assertSafeFetchUrl('https://api.stripe.com/v1/charges');
    expect(() => assertSafeSpecSize(6 * 1024 * 1024)).toThrow();
    expect(() => assertSafeSpecSize(1000, 1000 * 25)).toThrow();
    expect(() => assertSafeCandidate(101, 10)).toThrow();
  });
});
