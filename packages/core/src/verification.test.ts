import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  computeCandidateDigest,
  verifyCandidate,
  redactLog,
  DEFAULT_PROFILE,
} from "../src/verification.js";

function mkfiles(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fr08-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe("FR-08/FR-10 verification and candidate binding", () => {
  it("computes a stable digest that changes with content, profile, and base", async () => {
    const f = new Map([["a.ts", "hello"]]);
    const d1 = (await computeCandidateDigest(f, [])).digest;
    const d2 = (await computeCandidateDigest(new Map([["a.ts", "hello"]]), [])).digest;
    const d3 = (await computeCandidateDigest(new Map([["a.ts", "bye"]]), [])).digest;
    expect(d1).toBe(d2);
    expect(d1).not.toBe(d3);
    const dProfile = (
      await computeCandidateDigest(f, [], { profileId: "other-v1" })
    ).digest;
    expect(dProfile).not.toBe(d1);
    const dBase = (
      await computeCandidateDigest(f, [], { baseSha: "0".repeat(40) })
    ).digest;
    expect(dBase).not.toBe(d1);
  });

  it("empty candidate is INCOMPLETE, never VERIFIED", async () => {
    const dir = mkfiles({ "package.json": JSON.stringify({ name: "x" }) });
    const run = await verifyCandidate(dir, new Map(), [], { timeoutMs: 30000 });
    expect(run.verdict).toBe("INCOMPLETE");
    expect(run.dimensions.find((d) => d.name === "types-build")?.status).toBe("NOT_RUN");
    expect(run.candidateDigest).toMatch(/^[0-9a-f]{64}$/);
  }, 60000);

  it("install-only success (types pass, no tests) is INCOMPLETE, not VERIFIED", async () => {
    const dir = mkfiles({
      "package.json": JSON.stringify({ name: "x", dependencies: {} }),
      "a.ts": "export const x: number = 1;\n",
    });
    const run = await verifyCandidate(
      dir,
      new Map([["a.ts", "export const x: number = 1;\n"]]),
      [],
      { timeoutMs: 60000 }
    );
    expect(run.dimensions.find((d) => d.name === "types-build")?.status).toBe("PASS");
    expect(run.dimensions.find((d) => d.name === "unit-tests")?.status).toBe("NOT_RUN");
    expect(run.verdict).toBe("INCOMPLETE");
  }, 90000);

  it("failing typecheck is FAILED", async () => {
    const dir = mkfiles({
      "package.json": JSON.stringify({ name: "x", dependencies: {} }),
      "a.ts": "const x: number = \"nope\";\nexport {};\n",
    });
    const run = await verifyCandidate(dir, new Map([["a.ts", "bad"]]), [], { timeoutMs: 60000 });
    expect(run.dimensions.find((d) => d.name === "types-build")?.status).toBe("FAIL");
    expect(run.verdict).toBe("FAILED");
  }, 90000);

  it("passing tests plus types is VERIFIED; failing tests is FAILED", async () => {
    const good = mkfiles({
      "package.json": JSON.stringify({ name: "x", scripts: { test: "node -e \"process.exit(0)\"" } }),
      "a.ts": "export const x: number = 1;\n",
    });
    const runGood = await verifyCandidate(
      good,
      new Map([["a.ts", "export const x: number = 1;\n"]]),
      [],
      { timeoutMs: 60000 }
    );
    expect(runGood.dimensions.find((d) => d.name === "unit-tests")?.status).toBe("PASS");
    expect(runGood.verdict).toBe("VERIFIED");

    const bad = mkfiles({
      "package.json": JSON.stringify({ name: "x", scripts: { test: "node -e \"process.exit(1)\"" } }),
      "a.ts": "export const x: number = 1;\n",
    });
    const runBad = await verifyCandidate(
      bad,
      new Map([["a.ts", "export const x: number = 1;\n"]]),
      [],
      { timeoutMs: 60000 }
    );
    expect(runBad.dimensions.find((d) => d.name === "unit-tests")?.status).toBe("FAIL");
    expect(runBad.verdict).toBe("FAILED");
  }, 120000);

  it("redacts secrets and bounds log length", () => {
    expect(redactLog("key sk-test-abc123XYZ end")).toContain("sk-***");
    expect(redactLog("token ghp_abcdef123456 end")).not.toContain("ghp_abcdef123456");
    expect(redactLog("x".repeat(9000)).length).toBeLessThan(9000);
  });

  it("default profile requires all three dimensions", () => {
    expect(DEFAULT_PROFILE.required).toEqual(
      expect.arrayContaining(["dependency-resolution", "types-build", "unit-tests"])
    );
  });
});
