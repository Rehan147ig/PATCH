import { describe, it, expect } from "vitest";
import {
  branchNameForDigest,
  isPatchBranch,
  resolveFreeBranch,
  checkFreshness,
  isBaselineKnown,
  gateDelivery,
  PATCH_BRANCH_PREFIX,
} from "../src/delivery.js";

describe("FR-10 delivery safety", () => {
  it("names candidate-specific branches deterministically", () => {
    const a = branchNameForDigest("ab".repeat(32));
    const b = branchNameForDigest("ab".repeat(32));
    const c = branchNameForDigest("cd".repeat(32));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith(PATCH_BRANCH_PREFIX)).toBe(true);
    expect(a).not.toContain("auto-migration");
  });

  it("recognizes PATCH-owned branches", () => {
    expect(isPatchBranch("apimigrate/abc123")).toBe(true);
    expect(isPatchBranch("main")).toBe(false);
    expect(isPatchBranch("feature/x")).toBe(false);
  });

  it("resolves a free branch without touching existing refs", async () => {
    const taken = new Set(["apimigrate/abc", "apimigrate/abc-2"]);
    const r1 = await resolveFreeBranch("apimigrate/abc", async (b) => taken.has(b));
    expect(r1.branch).toBe("apimigrate/abc-3");
    expect(r1.diverged).toBe(true);
    const r2 = await resolveFreeBranch("apimigrate/free", async (b) => taken.has(b));
    expect(r2.branch).toBe("apimigrate/free");
    expect(r2.diverged).toBe(false);
  });

  it("detects stale digests and moved bases", () => {
    const run = { candidateDigest: "d1", baseSha: "b1" };
    expect(checkFreshness(run, { digest: "d1", baseSha: "b1" })).toEqual({ fresh: true });
    expect(checkFreshness(run, { digest: "d2", baseSha: "b1" })).toEqual({
      fresh: false,
      reason: "digest-mismatch",
    });
    expect(checkFreshness(run, { digest: "d1", baseSha: "b2" })).toEqual({
      fresh: false,
      reason: "base-mismatch",
    });
  });

  it("gates delivery: failed/stale/automatic-incomplete never deliver", () => {
    expect(
      gateDelivery({ verdict: "FAILED", fresh: true, baselineKnown: true, explicitApproval: true })
    ).toMatchObject({ ok: false, reason: "not-verified" });
    expect(
      gateDelivery({ verdict: "VERIFIED", fresh: false, baselineKnown: true, explicitApproval: true })
    ).toMatchObject({ ok: false, reason: "stale" });
    // INCOMPLETE without explicit approval is blocked even when fresh.
    expect(
      gateDelivery({ verdict: "INCOMPLETE", fresh: true, baselineKnown: true, explicitApproval: false })
    ).toMatchObject({ ok: false, reason: "needs-approval" });
    // Unknown baseline blocks automatic promotion but not explicit delivery.
    expect(
      gateDelivery({ verdict: "VERIFIED", fresh: true, baselineKnown: false, explicitApproval: false })
    ).toMatchObject({ ok: false, reason: "unknown-baseline" });
    expect(
      gateDelivery({ verdict: "VERIFIED", fresh: true, baselineKnown: false, explicitApproval: true })
    ).toEqual({ ok: true });
    expect(
      gateDelivery({ verdict: "VERIFIED", fresh: true, baselineKnown: true, explicitApproval: false })
    ).toEqual({ ok: true });
  });

  it("classifies baseline knowledge", () => {
    expect(isBaselineKnown("abc")).toBe(true);
    expect(isBaselineKnown(null)).toBe(false);
    expect(isBaselineKnown("")).toBe(false);
  });
});
