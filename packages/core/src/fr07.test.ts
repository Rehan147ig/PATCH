import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanDirectory } from "../src/scanner.js";
import { planCodemods } from "../src/codemod.js";
import type { MigrationManifest } from "../src/types.js";

const renameSkus = (): MigrationManifest => ({
  schemaVersion: "1.0",
  id: "fr07-skus",
  vendor: "stripe",
  title: "t",
  severity: "deprecation",
  lang: "typescript",
  changedAt: "2026-01-01",
  changes: [
    {
      type: "deprecated-call",
      description: "skus deprecated",
      match: { call: { name: "skus", object: "stripe" } },
      fix: { kind: "rename-call", from: "stripe.skus", to: "stripe.products" },
    },
  ],
});

const skuParam = (): MigrationManifest => ({
  schemaVersion: "1.0",
  id: "fr07-sku-param",
  vendor: "stripe",
  title: "t",
  severity: "deprecation",
  lang: "typescript",
  changedAt: "2026-01-01",
  changes: [
    {
      type: "removed-parameter",
      description: "sku param deprecated",
      match: {
        call: { name: "create", object: "stripe.subscriptions" },
        parameter: { name: "sku" },
      },
    },
  ],
});

describe("FR-07 focused candidates", () => {
  it("rejects changes in comments", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fr07-"));
    writeFileSync(path.join(dir, "a.ts"), "// stripe.skus.list() is deprecated\nconst x = 1;\n");
    const reports = await scanDirectory(dir, [renameSkus()]);
    expect(reports).toHaveLength(0);
  });

  it("rejects changes in string literals", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fr07-"));
    writeFileSync(path.join(dir, "a.ts"), "const s = \"stripe.skus.list()\";\n");
    const reports = await scanDirectory(dir, [renameSkus()]);
    expect(reports).toHaveLength(0);
  });

  it("rejects unrelated symbols with the same leaf name", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fr07-"));
    writeFileSync(path.join(dir, "a.ts"), "const order = { amount: 42 };\nconsole.log(order.amount);\n");
    const m: MigrationManifest = {
      schemaVersion: "1.0", id: "fr07-amount", vendor: "t", title: "t",
      severity: "breaking", lang: "typescript", changedAt: "2026-01-01",
      changes: [{ type: "renamed-field", description: "charge.amount", match: { field: { name: "amount", object: "charge" } } }],
    };
    const reports = await scanDirectory(dir, [m]);
    expect(reports).toHaveLength(0);
  });

  it("requires compound call+parameter in the same call site", async () => {
    const dirFar = mkdtempSync(path.join(tmpdir(), "fr07-"));
    writeFileSync(
      path.join(dirFar, "a.ts"),
      "stripe.subscriptions.create({customer:\"c\"});\nconst x={sku:\"orphan\"};\n"
    );
    expect(await scanDirectory(dirFar, [skuParam()])).toHaveLength(0);

    const dirNear = mkdtempSync(path.join(tmpdir(), "fr07-"));
    writeFileSync(
      path.join(dirNear, "a.ts"),
      "stripe.subscriptions.create({customer:\"c\", sku:\"sku_1\"});\n"
    );
    const near = await scanDirectory(dirNear, [skuParam()]);
    expect(near).toHaveLength(1);
    expect(near[0].hits).toHaveLength(1);
  });

  it("binds hits to exact offsets with correct identity", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fr07-"));
    writeFileSync(path.join(dir, "a.ts"), "const s = stripe.skus.list();\n");
    const reports = await scanDirectory(dir, [renameSkus()]);
    expect(reports).toHaveLength(1);
    const hit = reports[0].hits[0];
    expect(hit.manifestId).toBe("fr07-skus");
    expect(hit.changeIndex).toBe(0);
    expect(hit.offset).toBeDefined();
    expect(hit.endOffset).toBeGreaterThan(hit.offset!);
    const src = readFileSync(path.join(dir, "a.ts"), "utf8");
    expect(src.slice(hit.offset!, hit.endOffset!)).toBe(hit.snippet);
  });

  it("applies position-aware edits and leaves comments untouched", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fr07-"));
    writeFileSync(
      path.join(dir, "a.ts"),
      "// stripe.skus.list()\nconst s = stripe.skus.list();\n"
    );
    const reports = await scanDirectory(dir, [renameSkus()]);
    expect(reports[0].hits).toHaveLength(1);
    const plan = planCodemods(reports, dir);
    expect(plan.replacements).toBe(1);
    const out = plan.changedFiles.get("a.ts")!;
    const lines = out.split("\n");
    expect(lines[0]).toBe("// stripe.skus.list()");
    expect(lines[1]).toBe("const s = stripe.products.list();");
  });

  it("rejects stale hits instead of corrupting unrelated text", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fr07-"));
    writeFileSync(path.join(dir, "a.ts"), "const s = stripe.skus.list();\n");
    const reports = await scanDirectory(dir, [renameSkus()]);
    // Mutate the file after scanning: same text length region, different symbol.
    writeFileSync(path.join(dir, "a.ts"), "const s = stripe.xxxx.list();\n");
    const plan = planCodemods(reports, dir);
    expect(plan.replacements).toBe(0);
    expect(plan.changedFiles.size).toBe(0);
    expect(plan.unfixed.length).toBeGreaterThan(0);
  });
});
