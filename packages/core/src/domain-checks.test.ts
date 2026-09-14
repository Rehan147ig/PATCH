import { describe, it, expect } from 'vitest';
import { evaluatePaymentChecks, evaluateAiSwap } from './domain-checks.js';

describe('domain checks (scenarios 13, 14)', () => {
  it('blocks payment delivery when webhook/idempotency fails despite typecheck', () => {
    const { blocked } = evaluatePaymentChecks({
      required: ['webhook-verify', 'idempotency', 'refunds'],
      results: {
        'webhook-verify': { pass: false, reason: 'signature mismatch on duplicate event' },
        idempotency: { pass: true },
        refunds: { pass: true },
      },
      scopeJustification: 'change touches webhook handler',
    });
    expect(blocked).toBe(true);
  });

  it('requires full lifecycle for payment changes; metadata-only scope must justify', () => {
    const { checks, blocked } = evaluatePaymentChecks({
      required: ['initiation', 'reconciliation'],
      results: { initiation: { pass: true } },
    });
    expect(blocked).toBe(true);
    expect(checks.find((c) => c.name === 'payment:reconciliation')?.status).toBe('NOT_RUN');
  });

  it('model swap passing HTTP but failing quality needs review, no equivalence', () => {
    const r = evaluateAiSwap({
      taskSuccess: 0.7, successThreshold: 0.9, latencyMsP95: 800, latencyBudgetMs: 1000,
      costUsd: 1.2, costBudgetUsd: 2, modelProvenance: 'openai:gpt-4o-2024-08-06', httpChecksPass: true,
    });
    expect(r.equivalent).toBe(false);
    expect(r.needsReview).toBe(true);
  });
});
