import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  ScanReport,
  ValidationDimension,
  ValidationDimensionName,
  ValidationProfile,
  ValidationRun,
  ValidationVerdict,
} from "./types.js";

/** Codemod + validation recipe version. Bumped whenever edit or check semantics change. */
export const RECIPE_VERSION = "core-fR07-fR08-v1";
export const DEFAULT_PROFILE: ValidationProfile = {
  id: "default-v1",
  required: ["dependency-resolution", "types-build", "unit-tests"],
};

function sha256Hex(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

function shortHash(s: string | Buffer): string {
  return sha256Hex(s).slice(0, 12);
}

/**
 * FR-10: immutable candidate binding.
 * Any change to files, manifests, recipe, profile, lockfile, or base commit
 * yields a different digest. Approvals and ValidationRuns reference this
 * digest; when it changes, previous approval/validation is inapplicable.
 */
export async function computeCandidateDigest(
  changedFiles: Map<string, string>,
  reports: ScanReport[],
  opts: {
    recipeVersion?: string;
    profileId?: string;
    baseSha?: string | null;
    lockfileDigest?: string | null;
  } = {}
): Promise<{ digest: string; fileDigests: Record<string, string> }> {
  const fileDigests: Record<string, string> = {};
  const sorted = [...changedFiles.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [rel, content] of sorted) {
    fileDigests[rel] = shortHash(content);
  }
  const sourceIds = reports
    .flatMap((r) => r.hits.map((h) => `${h.manifestId}:${h.changeIndex}:${h.file}:${h.line}:${h.snippet}`))
    .sort()
    .join("\n");
  const payload = JSON.stringify({
    recipe: opts.recipeVersion ?? RECIPE_VERSION,
    profile: opts.profileId ?? DEFAULT_PROFILE.id,
    base: opts.baseSha ?? null,
    lockfile: opts.lockfileDigest ?? null,
    files: sorted.map(([rel, content]) => [rel, sha256Hex(content)]),
    sources: sha256Hex(sourceIds),
  });
  return { digest: sha256Hex(payload), fileDigests };
}

export async function getBaseSha(rootDir: string): Promise<string | null> {
  try {
    const out = await runCmd("git", ["rev-parse", "HEAD"], rootDir, 10000);
    const sha = (out.stdout + out.stderr).trim().split("\n")[0].trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export async function getLockfileDigest(rootDir: string): Promise<string | null> {
  for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
    try {
      const buf = await fs.readFile(path.join(rootDir, name));
      return shortHash(buf);
    } catch {
      // try next
    }
  }
  return null;
}

/** Redact likely secrets and bound length. Never persist raw credentials. */
export function redactLog(raw: string, maxChars = 8000): string {
  let s = raw;
  s = s.replace(/sk-(live|test)-[A-Za-z0-9_-]+/g, "sk-***");
  s = s.replace(/gh[pousr]_[A-Za-z0-9_]+/g, "gh***");
  s = s.replace(/AKIA[0-9A-Z]{16}/g, "AKIA***");
  s = s.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer ***");
  s = s.replace(/(api[_-]?key\s*[:=]\s*)(['\"]?)[^'\"\s]+(['\"]?)/gi, "$1$2***$3");
  if (s.length > maxChars) {
    s = s.slice(0, maxChars) + `\n...[truncated ${s.length - maxChars} chars]`;
  }
  return s;
}

interface CmdResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Resolve the TypeScript compiler without depending on PATH shims.
 * `npx tsc` fails on machines without a global install (npx then fetches an
 * unrelated package named `tsc`); running the workspace's own tsc.js with
 * the current node works everywhere this package's dependencies are
 * installed. Falls back to `npx tsc` when resolution fails.
 */
function tscRunner(): { cmd: string; prefix: string[]; label: string } {
  try {
    const tscJs = createRequire(import.meta.url).resolve("typescript/lib/tsc.js");
    return { cmd: process.execPath, prefix: [tscJs], label: "node <workspace>/typescript/lib/tsc.js" };
  } catch {
    return { cmd: "npx", prefix: ["tsc"], label: "npx tsc" };
  }
}

function runCmd(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<CmdResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    // Windows: bare `npm`/`npx` are .cmd/.ps1 shims that only resolve through
    // a shell — but a shell breaks executable paths containing spaces
    // (e.g. `C:\Program Files\nodejs\node.exe`), so use it only for
    // PATH-resolved bare command names.
    const shell =
      process.platform === "win32" && !cmd.includes("/") && !cmd.includes("\\") && !cmd.includes(":");
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, shell }, (err, stdout, stderr) => {
      const durationMs = Date.now() - started;
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ exitCode: 127, stdout: String(stdout ?? ""), stderr: `command not found: ${cmd}`, durationMs });
        return;
      }
      const exitCode = (err as { code?: number } | null)?.code ?? 0;
      resolve({ exitCode: typeof exitCode === "number" ? exitCode : 1, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), durationMs });
    });
  });
}

async function toolVersion(cmd: string, args: string[], cwd: string): Promise<string | null> {
  try {
    const r = await runCmd(cmd, args, cwd, 10000);
    if (r.exitCode !== 0) return null;
    return (r.stdout + r.stderr).trim().split("\n")[0].slice(0, 80) || null;
  } catch {
    return null;
  }
}

function hasTestScript(rootDir: string): Promise<boolean> {
  return fs
    .readFile(path.join(rootDir, "package.json"), "utf8")
    .then((raw) => {
      try {
        const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
        return typeof pkg.scripts?.test === "string" && pkg.scripts.test.length > 0;
      } catch {
        return false;
      }
    })
    .catch(() => false);
}

function hasTsFiles(changedFiles: Map<string, string>): boolean {
  for (const rel of changedFiles.keys()) {
    if (/\.m?[tj]sx?$/.test(rel)) return true;
  }
  return false;
}

/**
 * FR-08: verify actual candidate behavior with separate dimensions.
 * - dependency-resolution, types-build, unit-tests each report
 *   PASS/FAIL/NOT_RUN/NOT_APPLICABLE/INCONCLUSIVE with reasons.
 * - VERIFIED only when every required dimension PASSes. Install-only success,
 *   missing tests, skipped checks, unavailable compilers, or empty lists are
 *   INCOMPLETE or FAILED � never VERIFIED.
 * - All validators are awaited; a pending Promise is never treated as truthy.
 */
export async function verifyCandidate(
  rootDir: string,
  changedFiles: Map<string, string>,
  reports: ScanReport[] = [],
  opts: { profile?: ValidationProfile; timeoutMs?: number } = {}
): Promise<ValidationRun> {
  const profile = opts.profile ?? DEFAULT_PROFILE;
  const timeoutMs = opts.timeoutMs ?? 120000;
  const startedAt = new Date().toISOString();
  const started = Date.now();

  const baseSha = await getBaseSha(rootDir);
  const lockfileDigest = await getLockfileDigest(rootDir);
  const { digest, fileDigests } = await computeCandidateDigest(changedFiles, reports, {
    profileId: profile.id,
    baseSha,
    lockfileDigest,
  });

  const dimensions: ValidationDimension[] = [];

  // 1. dependency-resolution
  {
    const t0 = Date.now();
    let pkgExists = true;
    try {
      await fs.access(path.join(rootDir, "package.json"));
    } catch {
      pkgExists = false;
    }
    if (!pkgExists) {
      dimensions.push({
        name: "dependency-resolution",
        status: "INCONCLUSIVE",
        reason: "no package.json: installed dependency graph unknown",
        durationMs: Date.now() - t0,
      });
    } else {
      const r = await runCmd("npm", ["ls", "--depth=0"], rootDir, Math.min(timeoutMs, 30000));
      const log = redactLog(`$ npm ls --depth=0\n${r.stdout}\n${r.stderr}`);
      if (r.exitCode === 0) {
        dimensions.push({
          name: "dependency-resolution",
          status: "PASS",
          reason: "npm ls resolved the installed graph",
          command: "npm ls --depth=0",
          exitCode: 0,
          durationMs: Date.now() - t0,
          logExcerpt: log,
        });
      } else if (r.exitCode === 127) {
        dimensions.push({
          name: "dependency-resolution",
          status: "INCONCLUSIVE",
          reason: "npm unavailable: cannot resolve dependency graph",
          command: "npm ls --depth=0",
          exitCode: r.exitCode,
          durationMs: Date.now() - t0,
          logExcerpt: log,
        });
      } else {
        dimensions.push({
          name: "dependency-resolution",
          status: "FAIL",
          reason: "installed dependency graph does not resolve",
          command: "npm ls --depth=0",
          exitCode: r.exitCode,
          durationMs: Date.now() - t0,
          logExcerpt: log,
        });
      }
    }
  }

  // 2. types-build
  {
    const t0 = Date.now();
    if (changedFiles.size === 0) {
      dimensions.push({
        name: "types-build",
        status: "NOT_RUN",
        reason: "empty candidate: nothing to typecheck",
        durationMs: Date.now() - t0,
      });
    } else if (!hasTsFiles(changedFiles)) {
      dimensions.push({
        name: "types-build",
        status: "NOT_APPLICABLE",
        reason: "no TS/JS files in candidate",
        durationMs: Date.now() - t0,
      });
    } else {
      // If the repo has no tsconfig, `tsc --noEmit` with no file args prints
      // help and exits 1 (missing config, not a type error). Pass the
      // candidate TS files explicitly so the signal is real either way.
      let tsconfigExists = true;
      try {
        await fs.access(path.join(rootDir, 'tsconfig.json'));
      } catch {
        tsconfigExists = false;
      }
      const tsFiles = [...changedFiles.keys()].filter((f) => /\.m?[tj]sx?$/.test(f));
      const tsc = tscRunner();
      const tscArgs = tsconfigExists
        ? [...tsc.prefix, "--noEmit"]
        : [...tsc.prefix, "--noEmit", "--skipLibCheck", ...tsFiles];
      const r = await runCmd(tsc.cmd, tscArgs, rootDir, timeoutMs);
      const log = redactLog(`$ ${tsc.label} ${tscArgs.slice(tsc.prefix.length).join(" ")}\n${r.stdout}\n${r.stderr}`);
      const cmdStr = `$ ${tsc.label} ${tscArgs.slice(tsc.prefix.length).join(" ")}`;
      if (r.exitCode === 0) {
        dimensions.push({
          name: "types-build",
          status: "PASS",
          reason: "tsc --noEmit passed on the candidate",
          command: cmdStr,
          exitCode: 0,
          durationMs: Date.now() - t0,
          logExcerpt: log,
        });
      } else if (r.exitCode === 127) {
        dimensions.push({
          name: "types-build",
          status: "INCONCLUSIVE",
          reason: "tsc unavailable: cannot verify types",
          command: cmdStr,
          exitCode: r.exitCode,
          durationMs: Date.now() - t0,
          logExcerpt: log,
        });
      } else {
        dimensions.push({
          name: "types-build",
          status: "FAIL",
          reason: "typecheck failed on the candidate",
          command: cmdStr,
          exitCode: r.exitCode,
          durationMs: Date.now() - t0,
          logExcerpt: log,
        });
      }
    }
  }

  // 3. unit-tests (awaited; never treat the Promise as truthy)
  {
    const t0 = Date.now();
    const testScript = await hasTestScript(rootDir);
    if (!testScript) {
      dimensions.push({
        name: "unit-tests",
        status: "NOT_RUN",
        reason: "no test script: behavioral evaluation missing",
        durationMs: Date.now() - t0,
      });
    } else if (changedFiles.size === 0) {
      dimensions.push({
        name: "unit-tests",
        status: "NOT_RUN",
        reason: "empty candidate: no tests executed",
        durationMs: Date.now() - t0,
      });
    } else {
      const r = await runCmd('npm', ['test'], rootDir, timeoutMs);
      const log = redactLog(`$ npm test\n${r.stdout}\n${r.stderr}`);
      const counts = parseTestCounts(r.stdout + "\n" + r.stderr);
      if (r.exitCode === 0) {
        dimensions.push({
          name: "unit-tests",
          status: "PASS",
          reason: "test command exited 0",
          command: "npm test",
          exitCode: 0,
          durationMs: Date.now() - t0,
          logExcerpt: log,
          testCounts: counts,
        });
      } else {
        dimensions.push({
          name: "unit-tests",
          status: "FAIL",
          reason: "test command failed or timed out",
          command: "npm test",
          exitCode: r.exitCode,
          durationMs: Date.now() - t0,
          logExcerpt: log,
          testCounts: counts,
        });
      }
    }
  }

  const byName = new Map<ValidationDimensionName, ValidationDimension>(dimensions.map((d) => [d.name, d]));
  let verdict: ValidationVerdict = "VERIFIED";
  for (const name of profile.required) {
    const d = byName.get(name);
    // Missing dimension entry can never count as success (async-false safety).
    if (!d || d.status !== "PASS") {
      if (d?.status === "FAIL") {
        verdict = "FAILED";
        break;
      }
      verdict = "INCOMPLETE";
    }
  }
  if (verdict === "VERIFIED" && changedFiles.size === 0) {
    verdict = "INCOMPLETE";
  }

  const tsc = tscRunner();
  const [nodeV, npmV, tscV] = await Promise.all([
    toolVersion("node", ["--version"], rootDir),
    toolVersion("npm", ["--version"], rootDir),
    toolVersion(tsc.cmd, [...tsc.prefix, "--version"], rootDir),
  ]);

  void started;
  return {
    candidateDigest: digest,
    baseSha,
    profileId: profile.id,
    verdict,
    dimensions,
    startedAt,
    finishedAt: new Date().toISOString(),
    toolVersions: { node: nodeV, npm: npmV, tsc: tscV },
    fileCount: changedFiles.size,
    fileDigests,
  };
}

function parseTestCounts(output: string): { passed?: number; failed?: number; total?: number } {
  // vitest: "Test Files  5 passed (5)" / "Tests  26 passed (26)"
  const mFiles = output.match(/Test Files\s+(\d+)\s+passed/i);
  const mTests = output.match(/Tests\s+(\d+)\s+passed/i);
  const mFail = output.match(/(\d+)\s+failed/i);
  if (!mFiles && !mTests && !mFail) return {};
  return {
    passed: mTests ? Number(mTests[1]) : mFiles ? Number(mFiles[1]) : undefined,
    failed: mFail ? Number(mFail[1]) : 0,
    total: mTests ? Number(mTests[1]) + (mFail ? Number(mFail[1]) : 0) : undefined,
  };
}
