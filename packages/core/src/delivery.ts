import type { ValidationRun, ValidationVerdict } from "./types.js";

/**
 * FR-10 delivery safety.
 *
 * - Every candidate gets its own branch: `apimigrate/<12hex digest>`.
 *   A fixed shared branch lets unrelated candidates collide and lets retries
 *   overwrite user edits. Candidate-specific branches make delivery
 *   idempotent and auditable.
 * - PATCH never overwrites an existing branch: on collision it resolves a
 *   free suffixed name (`<branch>-2`, …) and leaves the existing ref alone.
 * - A ValidationRun is only valid for the exact digest + base SHA it was
 *   recorded against. Either changing invalidates it (stale).
 * - Unknown baselines (baseSha null) block *automatic* promotion; an
 *   explicit human approval (`--pr`, `--allow-incomplete`, dashboard
 *   approve) can still proceed, recorded as explicit.
 */

export const PATCH_BRANCH_PREFIX = "apimigrate/";
export const LEGACY_BRANCH = "apimigrate/auto-migration";
export const MAX_BRANCH_ATTEMPTS = 10;

export function branchNameForDigest(digest: string): string {
  const short = digest.slice(0, 12).toLowerCase().replace(/[^0-9a-f]/g, "").padEnd(12, "0").slice(0, 12);
  return `${PATCH_BRANCH_PREFIX}${short}`;
}

export function isPatchBranch(name: string): boolean {
  return name.startsWith(PATCH_BRANCH_PREFIX);
}

/**
 * Resolve a free branch name without touching existing refs.
 * `exists` is injected so the logic is unit-testable and the Octokit /
 * git CLI callers stay thin. Never deletes or force-moves anything.
 */
export async function resolveFreeBranch(
  wanted: string,
  exists: (branch: string) => Promise<boolean>,
  maxAttempts = MAX_BRANCH_ATTEMPTS
): Promise<{ branch: string; diverged: boolean }> {
  if (!(await exists(wanted))) return { branch: wanted, diverged: false };
  for (let i = 2; i <= maxAttempts; i++) {
    const alt = `${wanted}-${i}`;
    if (!(await exists(alt))) return { branch: alt, diverged: true };
  }
  throw new Error(`no free branch name for ${wanted} after ${maxAttempts} attempts`);
}

export type StaleReason = "digest-mismatch" | "base-mismatch";

export function checkFreshness(
  run: Pick<ValidationRun, "candidateDigest" | "baseSha">,
  current: { digest: string; baseSha: string | null }
): { fresh: true } | { fresh: false; reason: StaleReason } {
  if (run.candidateDigest !== current.digest) return { fresh: false, reason: "digest-mismatch" };
  if ((run.baseSha ?? null) !== (current.baseSha ?? null)) return { fresh: false, reason: "base-mismatch" };
  return { fresh: true };
}

export function isBaselineKnown(baseSha: string | null): boolean {
  return typeof baseSha === "string" && baseSha.length > 0;
}

export type DeliveryBlockReason =
  | "not-verified"
  | "stale"
  | "unknown-baseline"
  | "needs-approval";

export interface DeliveryGateInput {
  verdict: ValidationVerdict;
  fresh: boolean;
  baselineKnown: boolean;
  /** Explicit human authorization (CLI --pr/--allow-incomplete, dashboard approve). */
  explicitApproval: boolean;
}

export function gateDelivery(
  input: DeliveryGateInput
): { ok: true } | { ok: false; reason: DeliveryBlockReason; message: string } {
  if (input.verdict === "FAILED") {
    return {
      ok: false,
      reason: "not-verified",
      message: "verification FAILED; delivery blocked. Inspect the validation evidence.",
    };
  }
  if (!input.fresh) {
    return {
      ok: false,
      reason: "stale",
      message:
        "candidate changed since validation (digest or base SHA mismatch); revalidate before delivery.",
    };
  }
  if (input.verdict === "INCOMPLETE" && !input.explicitApproval) {
    return {
      ok: false,
      reason: "needs-approval",
      message:
        "verification INCOMPLETE; automatic promotion blocked. Re-run with explicit approval to open an unverified draft.",
    };
  }
  if (!input.baselineKnown && !input.explicitApproval) {
    return {
      ok: false,
      reason: "unknown-baseline",
      message: "unknown baseline blocks automatic promotion; explicit approval required.",
    };
  }
  return { ok: true };
}
