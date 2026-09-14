/**
 * FR-15: Meter fairly. Idempotent usage accounting; failures attributable to
 * PATCH are not billable completed outcomes. PRD §15 scenario 11: worker dies
 * after PR creation → retry reconciles one PR and ONE logical billing event.
 */
import { createHash } from 'node:crypto';

export type BillableOutcome = 'completed' | 'non-billable';
export type UsageKind = 'migration-delivered' | 'scan' | 'verification-run';

export interface UsageEvent {
  /** Idempotency key: hash(org, repo, candidateDigest, kind). Retries reuse it. */
  key: string;
  orgId: string;
  repoId: string;
  candidateDigest: string;
  kind: UsageKind;
  billable: BillableOutcome;
  /** Why non-billable (e.g. 'patch-failure', 'duplicate-retry', 'infra-error'). */
  reason?: string;
  createdAt: string;
}

export function usageKey(orgId: string, repoId: string, candidateDigest: string, kind: UsageKind): string {
  return createHash('sha256').update([orgId, repoId, candidateDigest, kind].join('|')).digest('hex').slice(0, 32);
}

export class UsageLedger {
  private events = new Map<string, UsageEvent>();

  /**
   * Record usage idempotently. Same (org, repo, digest, kind) returns the
   * original event — retries never double-bill (scenario 11).
   * billable='completed' only for genuinely delivered outcomes; PATCH-attributed
   * failures are recorded non-billable.
   */
  record(opts: {
    orgId: string; repoId: string; candidateDigest: string; kind: UsageKind;
    billable: BillableOutcome; reason?: string;
  }): { event: UsageEvent; duplicate: boolean } {
    const key = usageKey(opts.orgId, opts.repoId, opts.candidateDigest, opts.kind);
    const existing = this.events.get(key);
    if (existing) return { event: existing, duplicate: true };
    const event: UsageEvent = {
      key, orgId: opts.orgId, repoId: opts.repoId, candidateDigest: opts.candidateDigest,
      kind: opts.kind, billable: opts.billable, reason: opts.reason, createdAt: new Date().toISOString(),
    };
    this.events.set(key, event);
    return { event, duplicate: false };
  }

  billableCount(orgId?: string): number {
    return [...this.events.values()].filter((e) => e.billable === 'completed' && (orgId === undefined || e.orgId === orgId)).length;
  }

  forOrg(orgId: string): UsageEvent[] {
    return [...this.events.values()].filter((e) => e.orgId === orgId);
  }
}

/** Failures attributable to PATCH (infra, worker crash before evidence) are not billable. */
export function isPatchAttributableFailure(reason: string): boolean {
  return ['infra-error', 'patch-failure', 'runner-unavailable', 'ingest-error'].includes(reason);
}
