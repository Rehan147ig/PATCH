/**
 * Domain-specific verification profiles (§8): payment lifecycle + AI task
 * quality. Scenario 13: payment candidate passing typecheck but failing
 * webhook/idempotency is blocked. Scenario 14: model swap passing HTTP but
 * failing task-quality threshold needs review, no equivalence claim.
 */

export type DomainCheckStatus = 'PASS' | 'FAIL' | 'NOT_RUN' | 'NOT_APPLICABLE' | 'INCONCLUSIVE';
export interface DomainCheck {
  name: string;
  status: DomainCheckStatus;
  reason: string;
}

// Payment lifecycle stages (§8: initiation, auth/capture, failed/async,
// idempotency, webhook verify, duplicate/out-of-order, refunds, subscription
// changes, reconciliation; currency/amount interpretation).
export type PaymentStage =
  | 'initiation' | 'auth-capture' | 'failed-async' | 'idempotency'
  | 'webhook-verify' | 'duplicate-out-of-order' | 'refunds'
  | 'subscription-change' | 'reconciliation' | 'currency-amount';

export interface PaymentCheckInput {
  /** Stages the profile requires for this change family. */
  required: PaymentStage[];
  /** Stage -> run result (absent = NOT_RUN). */
  results: Partial<Record<PaymentStage, { pass: boolean; reason?: string }>>;
  /** Profile must justify scope when it omits stages (e.g. metadata-only read). */
  scopeJustification?: string;
}

export function evaluatePaymentChecks(input: PaymentCheckInput): { checks: DomainCheck[]; blocked: boolean } {
  const checks: DomainCheck[] = input.required.map((stage) => {
    const r = input.results[stage];
    if (!r) return { name: `payment:${stage}`, status: 'NOT_RUN', reason: 'required payment stage did not run' };
    return r.pass
      ? { name: `payment:${stage}`, status: 'PASS', reason: r.reason ?? 'stage passed in test env with synthetic data' }
      : { name: `payment:${stage}`, status: 'FAIL', reason: r.reason ?? 'stage failed' };
  });
  const blocked = checks.some((c) => c.status !== 'PASS');
  return { checks, blocked };
}

// AI task evaluation (§8: fixtures for task success, latency, cost vs
// customer thresholds; provenance preserved; no equivalence without eval).
export interface AiEvalInput {
  taskSuccess: number;
  successThreshold: number;
  latencyMsP95: number;
  latencyBudgetMs: number;
  costUsd: number;
  costBudgetUsd: number;
  modelProvenance: string;
  httpChecksPass: boolean;
}

export function evaluateAiSwap(input: AiEvalInput): { checks: DomainCheck[]; equivalent: boolean; needsReview: boolean } {
  const checks: DomainCheck[] = [
    {
      name: 'ai:task-success', status: input.taskSuccess >= input.successThreshold ? 'PASS' : 'FAIL',
      reason: `task success ${input.taskSuccess} vs threshold ${input.successThreshold} (${input.modelProvenance})`,
    },
    {
      name: 'ai:latency', status: input.latencyMsP95 <= input.latencyBudgetMs ? 'PASS' : 'FAIL',
      reason: `p95 ${input.latencyMsP95}ms vs budget ${input.latencyBudgetMs}ms`,
    },
    {
      name: 'ai:cost', status: input.costUsd <= input.costBudgetUsd ? 'PASS' : 'FAIL',
      reason: `cost $${input.costUsd} vs budget $${input.costBudgetUsd}`,
    },
  ];
  const equivalent = checks.every((c) => c.status === 'PASS');
  // HTTP-only pass without behavioral eval → incomplete, never equivalent.
  const needsReview = !equivalent || !input.httpChecksPass;
  return { checks, equivalent, needsReview };
}
