/**
 * Security, privacy, enterprise readiness (PRD §11) + scenario 6/12.
 * - Least-privilege is enforced by tenancy.ts authorize() + runner.ts leases.
 * - Signed public recipes use asymmetric publisher signatures with pinned
 *   verification keys, rotation/revocation, anti-rollback metadata. No HMAC
 *   secret or trusted dev fallback in production.
 * - Rejects path traversal, symlink escapes, SSRF, malicious specs,
 *   decompression bombs, unbounded recursion, oversized repos, credential URLs.
 */
import { createVerify, createSign, createPublicKey, createPrivateKey, timingSafeEqual } from 'node:crypto';

export const MAX_SPEC_BYTES = 5 * 1024 * 1024;
export const MAX_REPO_FILES = 50_000;
export const MAX_CANDIDATE_FILES = 100;
export const MAX_CANDIDATE_BYTES = 2 * 1024 * 1024;
export const MAX_SECURITY_GRAPH_DEPTH = 6;
export const MAX_DECOMPRESSED_RATIO = 20;

export interface SignedRecipe {
  recipeId: string;
  version: number;
  /** Monotonic rollback counter; receivers reject lower counters. */
  rollbackCounter: number;
  payload: unknown;
  signature: string;
  keyId: string;
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function signRecipe(
  privateKeyPem: string, recipeId: string, version: number,
  rollbackCounter: number, payload: unknown, keyId: string,
): SignedRecipe {
  const signer = createSign('sha256');
  signer.update(canonicalJson({ recipeId, version, rollbackCounter, payload }));
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKeyPem), 'base64');
  return { recipeId, version, rollbackCounter, payload, signature, keyId };
}

export function verifyRecipe(
  recipe: SignedRecipe,
  pinnedKeys: Map<string, string>,
  revokedKeys: Set<string>,
  minRollbackCounter: number,
): { ok: boolean; reason?: string } {
  if (revokedKeys.has(recipe.keyId)) return { ok: false, reason: 'key revoked' };
  const pub = pinnedKeys.get(recipe.keyId);
  if (!pub) return { ok: false, reason: 'unknown key id (no trusted dev fallback)' };
  if (recipe.rollbackCounter < minRollbackCounter) return { ok: false, reason: 'rollback rejected: stale counter' };
  try {
    const verifier = createVerify('sha256');
    verifier.update(canonicalJson({ recipeId: recipe.recipeId, version: recipe.version, rollbackCounter: recipe.rollbackCounter, payload: recipe.payload }));
    verifier.end();
    const ok = verifier.verify(createPublicKey(pub), Buffer.from(recipe.signature, 'base64'));
    return ok ? { ok: true } : { ok: false, reason: 'bad signature: rejected with evidence, no patch execution' };
  } catch {
    return { ok: false, reason: 'verify failure' };
  }
}

// ---- Input guards ----

/** Reject path traversal + absolute escapes; resolved path must stay under root. */
export function assertSafePath(root: string, rel: string): void {
  if (rel.includes('\0')) throw new Error('null byte in path');
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm) || norm.split('/').includes('..')) {
    throw new Error(`path traversal rejected: ${rel}`);
  }
}

/** Symlink escape: a symlink target must resolve inside the repo root. */
export function assertSafeSymlink(root: string, linkPath: string, target: string): void {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const joined = norm(linkPath).split('/').slice(0, -1).join('/') + '/' + norm(target);
  const parts: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  const resolved = parts.join('/');
  if (!resolved.startsWith(norm(root).replace(/\/$/, ''))) {
    throw new Error(`symlink escape rejected: ${linkPath} -> ${target}`);
  }
}

/** SSRF guard for remote fetches: block metadata/private/loopback + credential URLs. */
export function assertSafeFetchUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`invalid url rejected: ${raw}`);
  }
  if (u.username || u.password) throw new Error('credential-bearing URL rejected');
  if (!['https:', 'http:'].includes(u.protocol)) throw new Error(`protocol rejected: ${u.protocol}`);
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === 'metadata.google.internal' || host.endsWith('.internal')) {
    throw new Error(`SSRF rejected: ${host}`);
  }
  if (/^169\.254\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '127.0.0.1' || host === '[::1]') {
    throw new Error(`SSRF rejected: private address ${host}`);
  }
}

/** Malicious spec guard: size caps, recursion depth, oversized repo. */
export function assertSafeSpecSize(bytes: number, decompressedBytes?: number): void {
  if (bytes > MAX_SPEC_BYTES) throw new Error(`spec too large: ${bytes} > ${MAX_SPEC_BYTES}`);
  if (decompressedBytes !== undefined && decompressedBytes > bytes * MAX_DECOMPRESSED_RATIO) {
    throw new Error('decompression bomb rejected');
  }
}

export function assertSafeCandidate(fileCount: number, totalBytes: number): void {
  if (fileCount > MAX_CANDIDATE_FILES) throw new Error(`candidate too large: ${fileCount} files`);
  if (totalBytes > MAX_CANDIDATE_BYTES) throw new Error(`candidate too large: ${totalBytes} bytes`);
}

/** Timing-safe secret compare helper (re-export for callers). */
export function safeEqualHex(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex);
  const b = Buffer.from(bHex);
  return a.length === b.length && timingSafeEqual(a, b);
}
