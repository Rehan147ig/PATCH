/**
 * FR-11: Track outcomes + §9 workflow states. Distinguishes opened, accepted,
 * merged, deployed-confirmed, rejected, reverted, unknown (plus
 * accepted-with-edits / deferred for metrics). Verification and delivery
 * evidence remain separately addressable; a reconciled retry is one logical
 * outcome, not two.
 */

export type MigrationState =
  | 'DISCOVERED' | 'ASSESSING' | 'NO_APPLICABLE_IMPACT' | 'NEEDS_INFORMATION'
  | 'PLAN_ONLY' | 'GENERATING' | 'VERIFYING' | 'VALIDATION_FAILED'
  | 'AWAITING_APPROVAL' | 'VERIFIED' | 'DRAFT_OPEN' | 'MERGED'
  | 'DEPLOYMENT_CONFIRMED' | 'REJECTED' | 'REVERTED' | 'SUPERSEDED' | 'CANCELLED';

export type OutcomeKind =
  | 'opened' | 'accepted' | 'accepted-with-edits' | 'merged'
  | 'deployed-confirmed' | 'rejected' | 'rejected-as-wrong' | 'deferred'
  | 'reverted' | 'unknown';

export interface Outcome {
  caseId: string;
  orgId: string;
  kind: OutcomeKind;
  prNumber?: number | null;
  prUrl?: string | null;
  recordedAt: string;
  note?: string;
}

/** Legal state transitions (simplified; SUPERSEDED/CANCELLED reachable from most). */
const TRANSITIONS: Record<MigrationState, MigrationState[]> = {
  DISCOVERED: ['ASSESSING', 'CANCELLED'],
  ASSESSING: ['NO_APPLICABLE_IMPACT', 'NEEDS_INFORMATION', 'PLAN_ONLY', 'GENERATING', 'CANCELLED'],
  NO_APPLICABLE_IMPACT: ['ASSESSING', 'SUPERSEDED'],
  NEEDS_INFORMATION: ['ASSESSING', 'CANCELLED'],
  PLAN_ONLY: ['GENERATING', 'CANCELLED'],
  GENERATING: ['VERIFYING', 'VALIDATION_FAILED', 'CANCELLED'],
  VERIFYING: ['VALIDATION_FAILED', 'AWAITING_APPROVAL', 'VERIFIED'],
  VALIDATION_FAILED: ['GENERATING', 'PLAN_ONLY', 'CANCELLED'],
  AWAITING_APPROVAL: ['VERIFIED', 'REJECTED', 'CANCELLED'],
  VERIFIED: ['DRAFT_OPEN', 'SUPERSEDED'],
  DRAFT_OPEN: ['MERGED', 'REJECTED', 'SUPERSEDED'],
  MERGED: ['DEPLOYMENT_CONFIRMED', 'REVERTED'],
  DEPLOYMENT_CONFIRMED: ['REVERTED'],
  REJECTED: ['GENERATING'],
  REVERTED: [],
  SUPERSEDED: ['DISCOVERED'],
  CANCELLED: [],
};

export function canTransition(from: MigrationState, to: MigrationState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export class OutcomeTracker {
  private outcomes: Outcome[] = [];

  record(o: Omit<Outcome, 'recordedAt'> & { recordedAt?: string }): Outcome {
    const full: Outcome = { ...o, recordedAt: o.recordedAt ?? new Date().toISOString() };
    this.outcomes.push(full);
    return full;
  }

  /** Latest outcome per case (reconciled retries collapse to one logical outcome). */
  latest(caseId: string): Outcome | undefined {
    const list = this.outcomes.filter((o) => o.caseId === caseId);
    return list[list.length - 1];
  }

  summarize(): Record<OutcomeKind, number> {
    const counts = {} as Record<OutcomeKind, number>;
    for (const o of this.outcomes) counts[o.kind] = (counts[o.kind] ?? 0) + 1;
    return counts;
  }
}
