/**
 * FR-09: Enforce policy before external execution/delivery. Exact
 * candidate-bound approvals; sensitive changes and external data access
 * require configured authority. Approval authority is organization-owned;
 * payment/auth changes require explicit approval; optional two-person
 * approval follows customer policy. Public recipe approval never substitutes
 * for customer authorization.
 */

export type Sensitivity = 'standard' | 'sensitive-payment' | 'sensitive-auth' | 'external-data';

export interface Policy {
  orgId: string;
  /** e.g. ['lead', 'payments-owner'] — who may approve sensitive candidates. */
  sensitiveApprovers: string[];
  requireTwoPersonForSensitive: boolean;
  /** Authorities allowed to approve external-data access. */
  externalDataAuthorities: string[];
  /** Customer authorization is always required (never implied by recipe). */
  requireCustomerAuthorization: boolean;
}

export interface Approval {
  candidateDigest: string;
  approver: string;
  authority: string;
  createdAt: string;
}

export const SENSITIVE_KINDS = new Set(['sensitive-payment', 'sensitive-auth', 'external-data']);

export function classifySensitivity(opts: {
  touchesPayments?: boolean; touchesAuth?: boolean; accessesExternalData?: boolean;
}): Sensitivity {
  if (opts.touchesPayments) return 'sensitive-payment';
  if (opts.touchesAuth) return 'sensitive-auth';
  if (opts.accessesExternalData) return 'external-data';
  return 'standard';
}

export interface PolicyDecision { ok: boolean; reason?: string }

/**
 * Approvals are bound to the exact candidateDigest. Any digest change
 * invalidates prior approvals (caller must pass current digest + approvals
 * recorded against it).
 */
export function checkPolicy(
  policy: Policy,
  currentDigest: string,
  approvals: Approval[],
  sensitivity: Sensitivity,
): PolicyDecision {
  const bound = approvals.filter((a) => a.candidateDigest === currentDigest);
  if (bound.length === 0) {
    return { ok: false, reason: 'no candidate-bound approval for current digest' };
  }
  if (policy.requireCustomerAuthorization && !bound.some((a) => a.authority.startsWith('customer:'))) {
    return { ok: false, reason: 'public recipe approval cannot substitute for customer authorization' };
  }
  if (SENSITIVE_KINDS.has(sensitivity)) {
    const qualified = bound.filter((a) =>
      sensitivity === 'external-data'
        ? policy.externalDataAuthorities.includes(a.authority)
        : policy.sensitiveApprovers.includes(a.authority) || policy.sensitiveApprovers.includes(a.approver),
    );
    if (qualified.length === 0) {
      return { ok: false, reason: `${sensitivity} requires configured authority` };
    }
    if (policy.requireTwoPersonForSensitive) {
      const distinct = new Set(qualified.map((a) => a.approver));
      if (distinct.size < 2) return { ok: false, reason: 'two-person approval required for sensitive change' };
    }
  }
  return { ok: true };
}
