/**
 * FR-13: Shared runner protocol. Local/customer runner and hosted runner emit
 * IDENTICAL authenticated evidence schema. Customer runners poll signed
 * leases or receive authorized job messages through a defined protocol.
 * Scenario 12: malicious lifecycle scripts cannot reach host secrets or other
 * tenants — secrets are short-lived, narrowly scoped, brokered only to
 * approved checks, absent from general analysis/model contexts.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ValidationDimension, ValidationVerdict } from './types.js';

export type RunnerKind = 'customer' | 'hosted' | 'local';

export interface RunnerIdentity {
  id: string;
  orgId?: string | null;
  kind: RunnerKind;
}

export interface JobLease {
  jobId: string;
  orgId: string;
  repoId: string;
  candidateDigest: string;
  runnerId: string;
  issuedAt: number;
  expiresAt: number;
  /** HMAC over jobId|org|repo|digest|runner|expiry with the runner secret. */
  signature: string;
  allowedCommands: string[];
  /** Narrowly scoped, short-lived brokered secrets (never full env). */
  brokeredSecrets?: string[];
}

export interface EvidenceEnvelope {
  schemaVersion: '1.0';
  runnerId: string;
  runnerKind: RunnerKind;
  orgId: string;
  repoId: string;
  candidateDigest: string;
  baseSha: string | null;
  verdict: ValidationVerdict;
  dimensions: ValidationDimension[];
  toolVersions: Record<string, string | null>;
  imageDigest?: string | null;
  startedAt: string;
  finishedAt: string;
  signature: string;
}

function leasePayload(l: Omit<JobLease, 'signature'>): string {
  return [l.jobId, l.orgId, l.repoId, l.candidateDigest, l.runnerId, l.expiresAt].join('|');
}

export function signLease(lease: Omit<JobLease, 'signature'>, secret: string): JobLease {
  const signature = createHmac('sha256', secret).update(leasePayload(lease)).digest('hex');
  return { ...lease, signature };
}

export function verifyLease(lease: JobLease, secret: string, at = Date.now()): boolean {
  const expected = createHmac('sha256', secret).update(leasePayload(lease)).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(lease.signature);
  if (a.length !== b.length) return false;
  if (!timingSafeEqual(a, b)) return false;
  return at < lease.expiresAt && at >= lease.issuedAt - 60_000;
}

function evidencePayload(e: Omit<EvidenceEnvelope, 'signature'>): string {
  return JSON.stringify([e.schemaVersion, e.runnerId, e.runnerKind, e.orgId, e.repoId, e.candidateDigest, e.baseSha, e.verdict, e.dimensions]);
}

/** Both runner kinds sign the SAME envelope shape — identical schema. */
export function signEvidence(e: Omit<EvidenceEnvelope, 'signature'>, secret: string): EvidenceEnvelope {
  const signature = createHmac('sha256', secret).update(evidencePayload(e)).digest('hex');
  return { ...e, signature };
}

export function verifyEvidence(e: EvidenceEnvelope, secret: string): boolean {
  const { signature, ...rest } = e;
  const expected = createHmac('sha256', secret).update(evidencePayload(rest as Omit<EvidenceEnvelope, 'signature'>)).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Command allowlist: lifecycle scripts are never executed implicitly. */
const DENIED = new Set(['preinstall', 'postinstall', 'pretest', 'prepare']);
export function isCommandAllowed(cmd: string, lease: Pick<JobLease, 'allowedCommands'>): boolean {
  const base = cmd.split(' ')[0].split('/').pop() ?? cmd;
  if (DENIED.has(base)) return false;
  return lease.allowedCommands.some((a) => cmd === a || cmd.startsWith(a + ' '));
}
