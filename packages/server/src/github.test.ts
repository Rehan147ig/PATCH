import { describe, it, expect } from 'vitest';
import type { Octokit } from 'octokit';
import { verifyWebhookSignature, createMigrationPr, findExistingPr } from './github.js';
import { branchNameForDigest } from '@apimigrate/core';

describe('github webhook signature', () => {
  it('verifies a valid HMAC signature', () => {
    const secret = 's3cret';
    const body = '{"event":"test"}';
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const sig = 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(verifyWebhookSignature(secret, body, sig)).toBe(true);
  });

  it('rejects an invalid signature', () => {
    expect(verifyWebhookSignature('secret', '{"a":1}', 'sha256=deadbeef')).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifyWebhookSignature('secret', '{}', undefined)).toBe(false);
  });
});

describe("FR-10 delivery reconciliation", () => {
  function mockOctokit(pre: {
    refs?: Record<string, string>;
    openPrs?: Array<{ head: string; base: string; url: string; number: number }>;
  }) {
    const refs: Record<string, string> = { ...(pre.refs ?? {}) };
    const openPrs = [...(pre.openPrs ?? [])];
    const calls: string[] = [];
    let racePrOnCreate = false;
    const git = {
      getRef: async ({ ref }: { ref: string }) => {
        if (refs[ref] === undefined) {
          const e = new Error(`ref not found: ${ref}`) as Error & { status: number };
          e.status = 404;
          throw e;
        }
        return { data: { object: { sha: refs[ref] } } };
      },
      createRef: async ({ ref, sha }: { ref: string; sha: string }) => {
        calls.push(`createRef:${ref}`);
        const short = ref.replace("refs/heads/", "heads/");
        if (refs[short] !== undefined) {
          const e = new Error("ref exists") as Error & { status: number };
          e.status = 422;
          throw e;
        }
        refs[short] = sha;
        return { data: {} };
      },
      deleteRef: async () => {
        calls.push("deleteRef");
        throw new Error("deleteRef must never be called: PATCH never overwrites branches");
      },
      createTree: async () => ({ data: { sha: "tree1" } }),
      createCommit: async ({ parents }: { parents: string[] }) => {
        calls.push(`createCommit:parents=${parents.join(",")}`);
        return { data: { sha: "commit1" } };
      },
      updateRef: async ({ ref, sha, force }: { ref: string; sha: string; force: boolean }) => {
        calls.push(`updateRef:${ref}:force=${String(force)}`);
        expect(force).toBe(false);
        refs[ref] = sha;
        return { data: {} };
      },
    };
    const pulls = {
      list: async ({ head, base }: { head: string; base: string }) => {
        const branch = head.includes(":") ? head.split(":")[1] : head;
        return {
          data: openPrs
            .filter((p) => p.head === branch && p.base === base)
            .map((p) => ({ html_url: p.url, number: p.number })),
        };
      },
      create: async ({ head, base }: { head: string; base: string }) => {
        calls.push(`pulls.create:${head}`);
        if (racePrOnCreate) {
          // A concurrent creator won the race between our list and create.
          racePrOnCreate = false;
          openPrs.push({ head, base, url: `https://pr/${head}`, number: 99 });
          const e = new Error("pr exists") as Error & { status: number };
          e.status = 422;
          throw e;
        }
        if (openPrs.some((p) => p.head === head && p.base === base)) {
          const e = new Error("pr exists") as Error & { status: number };
          e.status = 422;
          throw e;
        }
        const pr = { head, base, url: `https://pr/${head}`, number: openPrs.length + 1 };
        openPrs.push(pr);
        return { data: { html_url: pr.url, number: pr.number } };
      },
    };
    return {
      octokit: { rest: { git, pulls } } as unknown as Octokit,
      calls,
      refs,
      openPrs,
      armRace: () => {
        racePrOnCreate = true;
      },
    };
  }

  const files = () => new Map([["a.ts", "const x = 1;\n"]]);

  it("reconciles an already-open PR without duplicating", async () => {
    const m = mockOctokit({
      refs: { "heads/main": "base1", "heads/apimigrate/abc123": "old" },
      openPrs: [{ head: "apimigrate/abc123", base: "main", url: "https://pr/existing", number: 7 }],
    });
    const res = await createMigrationPr(m.octokit, "o", "r", {
      base: "main",
      head: "apimigrate/abc123",
      title: "t",
      body: "b",
      changedFiles: files(),
    });
    expect(res).toMatchObject({ url: "https://pr/existing", number: 7, reconciled: true });
    expect(m.calls.filter((c) => c.startsWith("pulls.create"))).toHaveLength(0);
    expect(m.calls).not.toContain("deleteRef");
  });

  it("cuts a fresh branch from the live base SHA", async () => {
    const m = mockOctokit({ refs: { "heads/main": "base1" } });
    const res = await createMigrationPr(m.octokit, "o", "r", {
      base: "main",
      head: "apimigrate/new123",
      title: "t",
      body: "b",
      changedFiles: files(),
    });
    expect(res.head).toBe("apimigrate/new123");
    expect(m.refs["heads/apimigrate/new123"]).toBe("commit1");
    expect(m.calls).toContain("createCommit:parents=base1");
    expect(m.calls).not.toContain("deleteRef");
  });

  it("maps the legacy shared branch to a candidate-specific branch", async () => {
    const m = mockOctokit({ refs: { "heads/main": "base1" } });
    const digest = "ab".repeat(32);
    const res = await createMigrationPr(m.octokit, "o", "r", {
      base: "main",
      head: "apimigrate/auto-migration",
      title: "t",
      body: "b",
      changedFiles: files(),
      candidateDigest: digest,
    });
    expect(res.head).toBe(branchNameForDigest(digest));
    expect(res.head).not.toBe("apimigrate/auto-migration");
  });

  it("never deletes a taken branch; resolves a suffixed name instead", async () => {
    const m = mockOctokit({ refs: { "heads/main": "base1", "heads/apimigrate/taken1": "userwork" } });
    const res = await createMigrationPr(m.octokit, "o", "r", {
      base: "main",
      head: "apimigrate/taken1",
      title: "t",
      body: "b",
      changedFiles: files(),
    });
    expect(res.head).toBe("apimigrate/taken1-2");
    // The pre-existing ref is untouched.
    expect(m.refs["heads/apimigrate/taken1"]).toBe("userwork");
    expect(m.calls).not.toContain("deleteRef");
  });

  it("reconciles a lost pulls.create race instead of duplicating", async () => {
    const m = mockOctokit({ refs: { "heads/main": "base1" } });
    m.armRace();
    const res = await createMigrationPr(m.octokit, "o", "r", {
      base: "main",
      head: "apimigrate/race1",
      title: "t",
      body: "b",
      changedFiles: files(),
    });
    expect(res).toMatchObject({ number: 99, reconciled: true, head: "apimigrate/race1" });
    expect(m.openPrs.filter((p) => p.head === "apimigrate/race1")).toHaveLength(1);
  });

  it("findExistingPr returns null when no open PR matches", async () => {
    const m = mockOctokit({ refs: { "heads/main": "base1" } });
    expect(await findExistingPr(m.octokit, "o", "r", "apimigrate/none", "main")).toBeNull();
  });
});
