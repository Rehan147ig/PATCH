/**
 * §5 review tasks + §6 incremental index + §7 strategy order.
 * - Unknown/contradictory evidence creates a review task (never silently dropped).
 * - Incremental index per exact commit + extractor version; manifest/lockfile/
 *   compiler changes invalidate relevant resolution; traversal limits report
 *   incomplete and trigger full rescan (never silent completeness).
 * - Strategy order: official codemod → PATCH transform → bounded external-agent
 *   proposal → plan-only. LLMs never self-approve, run shell, or mutate evidence.
 */
import { createHash } from 'node:crypto';

// ---- Review tasks (§5) ----

export type ReviewReason = 'unknown-evidence' | 'contradictory-evidence' | 'untrusted-source-conflict' | 'license-excerpt-limit';

export interface ReviewTask {
  id: string;
  orgId: string;
  repoId?: string | null;
  reason: ReviewReason;
  detail: string;
  sourceRefs: string[];
  createdAt: string;
  resolvedAt?: string | null;
}

let reviewSeq = 1;

export function createReviewTask(
  orgId: string, reason: ReviewReason, detail: string, sourceRefs: string[] = [], repoId?: string | null,
): ReviewTask {
  return {
    id: `rev_${reviewSeq++}`, orgId, repoId: repoId ?? null, reason, detail,
    sourceRefs: sourceRefs.slice(0, 5), createdAt: new Date().toISOString(), resolvedAt: null,
  };
}

// ---- Incremental index (§6) ----

export interface IndexKey {
  commitSha: string;
  extractorVersion: string;
}

export interface IndexInvalidation {
  invalidated: boolean;
  reasons: string[];
}

export class RepoIndex {
  private entries = new Map<string, { key: IndexKey; indexedAt: number }>();

  index(repoId: string, key: IndexKey, at = Date.now()): void {
    this.entries.set(repoId, { key, indexedAt: at });
  }

  /**
   * Manifest, lockfile, or compiler config changes invalidate relevant resolution.
   * Any component change → re-resolve; traversal-limit hits → full scan.
   */
  check(
    repoId: string, current: IndexKey,
    signals: { manifestDigest?: string | null; knownManifestDigest?: string | null; lockfileDigest?: string | null; knownLockfileDigest?: string | null; compilerDigest?: string | null; knownCompilerDigest?: string | null; traversalLimited?: boolean },
  ): IndexInvalidation {
    const reasons: string[] = [];
    const prev = this.entries.get(repoId);
    if (!prev) {
      reasons.push('no prior index for commit/extractor');
    } else {
      if (prev.key.commitSha !== current.commitSha) reasons.push(`commit moved ${prev.key.commitSha.slice(0, 8)} → ${current.commitSha.slice(0, 8)}`);
      if (prev.key.extractorVersion !== current.extractorVersion) reasons.push('extractor version changed');
    }
    if (signals.manifestDigest !== undefined && signals.knownManifestDigest !== undefined && signals.manifestDigest !== signals.knownManifestDigest) {
      reasons.push('manifest changed: relevant resolution invalidated');
    }
    if (signals.lockfileDigest !== undefined && signals.knownLockfileDigest !== undefined && signals.lockfileDigest !== signals.knownLockfileDigest) {
      reasons.push('lockfile changed: relevant resolution invalidated');
    }
    if (signals.compilerDigest !== undefined && signals.knownCompilerDigest !== undefined && signals.compilerDigest !== signals.knownCompilerDigest) {
      reasons.push('compiler config changed: relevant resolution invalidated');
    }
    if (signals.traversalLimited) reasons.push('traversal limit hit: incomplete analysis, full scan required');
    return { invalidated: reasons.length > 0, reasons };
  }
}

// ---- Strategy dispatcher (§7) ----

export type StrategyKind = 'official-codemod' | 'patch-transform' | 'external-agent' | 'plan-only';

export interface OfficialCodemod {
  artifact: string;
  /** Pinned digest of the codemod artifact. */
  digest: string;
  license: string;
  provenance: string;
}

export interface StrategyDecision {
  strategy: StrategyKind;
  reason: string;
  official?: OfficialCodemod;
  /** Bounded external-agent proposal constraints (no shell, no self-approval). */
  agentBounds?: { maxFiles: number; maxBytes: number; allowShell: false; allowSelfApprove: false };
}

export function chooseStrategy(opts: {
  hasOfficialCodemod: boolean;
  official?: OfficialCodemod;
  hasQualifiedTransform: boolean;
  agentAllowed: boolean;
  safelyAutomatable: boolean;
}): StrategyDecision {
  if (opts.hasOfficialCodemod && opts.official?.digest && opts.official.license && opts.official.provenance) {
    return { strategy: 'official-codemod', reason: 'verified official codemod with pinned artifact', official: opts.official };
  }
  if (opts.hasQualifiedTransform) {
    return { strategy: 'patch-transform', reason: 'qualified PATCH transformation bound to exact symbols' };
  }
  if (opts.agentAllowed && opts.safelyAutomatable) {
    return {
      strategy: 'external-agent', reason: 'bounded external-agent proposal with source context',
      agentBounds: { maxFiles: 100, maxBytes: 2 * 1024 * 1024, allowShell: false, allowSelfApprove: false },
    };
  }
  return { strategy: 'plan-only', reason: 'not safely automatable: actionable plan with evidence' };
}

export function sha12(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 12);
}
