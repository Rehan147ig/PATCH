/**
 * §12 scale/reliability + §13 metrics/commercial instrumentation.
 * Qualification workloads are targets, not SLAs. Verification duration depends
 * on customer tests: visible time/spend budgets, never a universal PR promise.
 */

export interface Quota {
  maxConcurrentJobs: number;
  maxRepos: number;
  maxScansPerHour: number;
}

export const DEFAULT_QUOTA: Quota = { maxConcurrentJobs: 4, maxRepos: 500, maxScansPerHour: 60 };

export class TenantQuota {
  private running = new Map<string, number>();
  private scans: number[] = [];

  constructor(private quota: Quota = DEFAULT_QUOTA) {}

  /** Fair scheduling: reject with visible, recoverable error when over quota. */
  tryStart(orgId: string): { ok: boolean; reason?: string } {
    const n = this.running.get(orgId) ?? 0;
    if (n >= this.quota.maxConcurrentJobs) {
      return { ok: false, reason: `tenant quota: ${n}/${this.quota.maxConcurrentJobs} concurrent jobs; queued, visible and recoverable` };
    }
    this.running.set(orgId, n + 1);
    return { ok: true };
  }

  finish(orgId: string): void {
    this.running.set(orgId, Math.max(0, (this.running.get(orgId) ?? 1) - 1));
  }

  runningCount(orgId: string): number {
    return this.running.get(orgId) ?? 0;
  }
}

/** Rate-aware scheduling for provider feeds + GitHub (token bucket). */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(private capacity: number, private refillPerSec: number) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(at = Date.now()): void {
    const elapsed = (at - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = at;
  }

  tryTake(n = 1, at = Date.now()): boolean {
    this.refill(at);
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

export interface SloSample {
  kind: 'inventory-ms' | 'api-read-ms' | 'detection-lag-ms';
  ms: number;
  at: number;
}

export class SloTracker {
  private samples: SloSample[] = [];

  record(kind: SloSample['kind'], ms: number, at = Date.now()): void {
    this.samples.push({ kind, ms, at });
    if (this.samples.length > 5000) this.samples.splice(0, this.samples.length - 5000);
  }

  /** p95 per kind (independent of queue/clone delays — callers tag accordingly). */
  p95(kind: SloSample['kind']): number | null {
    const vals = this.samples.filter((s) => s.kind === kind).map((s) => s.ms).sort((a, b) => a - b);
    if (vals.length === 0) return null;
    return vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.95))];
  }
}

// ---- §13 evaluation harness ----

export interface LabeledCase {
  id: string;
  changeFamily: string;
  expectedAffected: boolean;
  predictedAffected: boolean;
  expectedInstance: boolean;
  predictedInstance: boolean;
}

export interface EvalResult {
  discoveryPrecision: number;
  discoveryRecall: number;
  impactPrecision: number;
  impactRecall: number;
  positives: number;
  negatives: number;
  ambiguous: number;
  repos: number;
  meetsThresholds: boolean;
  meetsMinimums: boolean;
}

export function evaluateCorpus(cases: LabeledCase[], repos: number, ambiguous: number): EvalResult {
  const positives = cases.filter((c) => c.expectedAffected).length;
  const negatives = cases.filter((c) => !c.expectedAffected).length;
  const tpImpact = cases.filter((c) => c.expectedAffected && c.predictedAffected).length;
  const fpImpact = cases.filter((c) => !c.expectedAffected && c.predictedAffected).length;
  const tpDisc = cases.filter((c) => c.expectedInstance && c.predictedInstance).length;
  const fpDisc = cases.filter((c) => !c.expectedInstance && c.predictedInstance).length;
  const fnDisc = cases.filter((c) => c.expectedInstance && !c.predictedInstance).length;
  const fnImpact = positives - tpImpact;
  const discoveryPrecision = tpDisc + fpDisc === 0 ? 1 : tpDisc / (tpDisc + fpDisc);
  const discoveryRecall = tpDisc + fnDisc === 0 ? 1 : tpDisc / (tpDisc + fnDisc);
  const impactPrecision = tpImpact + fpImpact === 0 ? 1 : tpImpact / (tpImpact + fpImpact);
  const impactRecall = positives === 0 ? 1 : tpImpact / (tpImpact + fnImpact);
  const meetsMinimums = positives >= 30 && negatives >= 30 && ambiguous >= 20 && repos >= 5;
  const meetsThresholds = impactPrecision >= 0.95 && impactRecall >= 0.9;
  return {
    discoveryPrecision, discoveryRecall, impactPrecision, impactRecall,
    positives, negatives, ambiguous, repos, meetsThresholds, meetsMinimums,
  };
}

export interface CostBreakdown {
  modelUsd: number;
  runnerUsd: number;
  fetchUsd: number;
  storageUsd: number;
  supportUsd: number;
  retriesUsd: number;
}

export function totalCost(c: CostBreakdown): number {
  return c.modelUsd + c.runnerUsd + c.fetchUsd + c.storageUsd + c.supportUsd + c.retriesUsd;
}

export interface DashboardSnapshot {
  sourceFreshness: Record<string, boolean>;
  queueAgeMs: number;
  runnerErrors: number;
  staleCandidates: number;
  duplicateDeliveryRate: number;
  unknownCoverage: number;
  outcomes: Record<string, number>;
  costPerCompletedMigration: number | null;
  deletionFailures: number;
  at: string;
}
