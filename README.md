# apimigrate

**API migration agent** — scan codebases against machine-readable API change manifests, apply mechanical codemods, and open migration PRs.

The thesis: API providers shouldn't just announce breaking changes; they should **apply** them. `apimigrate` is the application layer that connects API change announcements to customer codebases — like Dependabot, but for API migrations instead of version bumps.

```
vendor changelog ──► manifest (JSON) ──► scanner ──► codemod ──► PR
                     (curated)          (AST/lex)   (mechanical)   (verified)
```

## Why manifests?

The hard part of API migration is not the PR plumbing — it's knowing that *this* changelog line maps to *this* call pattern in a customer's codebase. The **migration manifest** is that knowledge, made machine-readable:

```json
{
  "schemaVersion": "1.0",
  "id": "stripe-2025-03-sku-deprecation",
  "vendor": "stripe",
  "title": "SKU API and `sku` parameter deprecated",
  "severity": "deprecation",
  "lang": "typescript",
  "changedAt": "2025-03-01",
  "changes": [
    {
      "type": "deprecated-call",
      "description": "The `skus` resource is deprecated; migrate to `products` + `prices`.",
      "match": { "call": { "name": "skus", "object": "stripe" } },
      "fix": {
        "kind": "rename-call",
        "from": "stripe.skus",
        "to": "stripe.products"
      }
    }
  ]
}
```

Manifests live in `manifests/<vendor>/*.json` and are validated against `schemas/manifest.schema.json`.

## What's here

| Package | Purpose |
| --- | --- |
| `packages/core` | Manifest loading, scanner engine, codemod planner. Pure JS — no native deps. |
| `packages/cli` | `apimigrate scan` / `apimigrate apply` — run against any repo locally. |
| `packages/server` | GitHub App backend — webhook receiver, installation auth, PR creation. |
| `packages/action` | GitHub Action — same engine in CI, opens a PR automatically. |
| `manifests/` | Curated vendor manifests (Stripe first). |
| `demo/` | A fake-but-realistic Stripe-using repo for end-to-end demos. |

## Quick start

```bash
npm install
npm run build

# Scan a repo for affected usages
node packages/cli/dist/cli.js scan demo --manifests manifests

# Apply mechanical fixes (writes files, verifies build)
node packages/cli/dist/cli.js apply demo --manifests manifests

# Plan without touching anything
node packages/cli/dist/cli.js apply demo --manifests manifests --dry-run

# JSON output for tooling
node packages/cli/dist/cli.js scan demo --manifests manifests --json
```

The demo repo contains realistic Stripe usage. The scan finds:

- `stripe.skus.*` deprecations (mechanically fixable → `stripe.products.*`)
- `sku:` parameter on `subscriptions.create` (report-only → needs human migration to `price`)
- `charge.amount` / `amount` integer-cents → decimal dollars (report-only)
- Missing `apiVersion` pin (report-only)

## How the scanner works

A small, dependency-free tokenizer/lexer walks each source file and extracts candidates:

- **calls**: dotted paths followed by `(`, e.g. `stripe.charges.create`
- **fields**: dotted member access and object literal keys, e.g. `charge.amount`
- **parameters**: argument keys inside call argument objects
- **sdk**: `import` / `require` package names

Manifest `match` patterns can be single (one kind) or **compound** (e.g. a call *and* a parameter must both appear — "the `sku` argument passed to `subscriptions.create`"). Compound matches require all patterns to be satisfied, so `order.amount` doesn't false-positive as `charge.amount`.

Each hit carries a `file:line`, confidence score, and — when the manifest defines a mechanical fix — a replacement string. Non-mechanical changes (`convert-amount`, `replace`) are reported as **manual** and never auto-applied.

## Codemod + verify

`apimigrate apply`:
1. Plans replacements from scan hits (prefix-aware: `stripe.skus.list` → `stripe.products.list`).
2. Writes changed files.
3. Runs `tsc --noEmit` (or your build command) to verify nothing broke.
4. Only then opens a PR (with `--pr` / via the GitHub App / Action).

If verification fails, no PR is opened — the diff is left for human review.

## GitHub App (self-hosted)

```bash
# Environment
export GITHUB_APP_ID=...
export GITHUB_APP_PRIVATE_KEY="$(cat app.pem)"
export GITHUB_WEBHOOK_SECRET=...
export APIMIGRATE_MANIFESTS=./manifests

npm run build --workspace @apimigrate/server
npm run start --workspace @apimigrate/server
```

Expose with `ngrok http 3000` and point the webhook at `/webhook`. The app responds to `repository` (created) and `repository_dispatch` (`apimigrate/scan`) events, cloning the repo, scanning, and opening a migration PR via installation auth.

## GitHub Action

```yaml
- uses: your-org/apimigrate@v1
  with:
    manifests: manifests
    token: ${{ secrets.GITHUB_TOKEN }}
```

Opens `apimigrate/auto-migration` PRs when affected usages are found. `fail-on-hits: true` turns it into a pre-merge gate instead.

## The business layer (not in this repo)

The 50-vendor catalog and billing are a company, not a codebase. The manifest format + scanner + PR pipeline is the provable core — one vendor (Stripe), fully mechanical, end-to-end.

## License

MIT
