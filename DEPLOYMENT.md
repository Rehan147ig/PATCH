# Deployment

apimigrate ships as a monorepo with four packages. This doc covers production deployment of the GitHub App backend and the GitHub Action.

## Prerequisites

- Node.js 22+
- A GitHub App (see below)
- (Optional) `gh` CLI for the local PR flow

## 1. Create the GitHub App

1. GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
2. Set **Webhook URL** to `https://<your-host>/webhook`.
3. Set **Webhook secret** to a long random string (used for HMAC verification).
4. Permissions:
   - **Contents**: Read & write (create branches, commits, trees)
   - **Pull requests**: Read & write (open PRs)
   - **Metadata**: Read
5. Subscribe to events: **Repository** (created) and **Repository dispatch**.
6. Generate a private key (`.pem`) and note the **App ID**.

## 2. Deploy the server

The server is a plain Express app; deploy it anywhere Node runs (Render, Railway, Fly.io, ECS, a VM).

```bash
cd packages/server
npm ci
npm run build
```

Environment variables:

| Variable | Required | Purpose |
| --- | --- | --- |
| `GITHUB_APP_ID` | yes | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | yes | App private key PEM contents |
| `GITHUB_WEBHOOK_SECRET` | no | Webhook secret (HMAC verification) |
| `APIMIGRATE_MANIFESTS` | no | Manifests dir (default `./manifests`) |
| `PORT` | no | Listen port (default 3000) |

Run:

```bash
npm run start
```

Health check: `GET /healthz`.

### Webhook events

- `repository` + action `created` → triggers an initial scan + PR on the new repo.
- `repository_dispatch` + action `apimigrate/scan` → on-demand scan (e.g. from a cron or CI).

### Local dev with ngrok

```bash
ngrok http 3000
# set the webhook URL to https://<ngrok-id>.ngrok.io/webhook
```

## 3. Install the app on repos

Users install the GitHub App on their repos (or an org). On install, the app can scan immediately (the `installation` webhook also works — add handling for `installation` + `created` if you want install-time scans).

## 4. GitHub Action (CI path)

The Action runs the same engine in CI without any server. Add to your workflow:

```yaml
name: apimigrate
on:
  schedule:
    - cron: '0 3 * * 1'   # weekly
  workflow_dispatch:

jobs:
  migrate:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: your-org/apimigrate@v1
        with:
          manifests: manifests
          token: ${{ secrets.GITHUB_TOKEN }}
```

### Action inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `manifests` | `manifests` | Manifest directory |
| `token` | `github.token` | Token with PR write scope |
| `base` | repo default branch | PR base |
| `branch` | `apimigrate/auto-migration` | PR branch |
| `fail-on-hits` | `false` | Fail the check when usages are found (gate mode) |

## 5. Production concerns

- **Scale**: the MVP server clones repos via the git trees API and scans in-process. For many repos, move scanning to a job queue (BullMQ / SQS) with per-repo workers.
- **Rate limits**: GitHub API calls (tree/blob fetch, PR creation) count against the app's installation quota. Batch and cache.
- **Security**: the app's installation token is scoped to the repos the user installed it on — it cannot touch other repos. Verify webhook signatures before trusting payloads.
- **Verification**: `apply` runs a build (`tsc --noEmit` by default) before opening a PR. Configure the correct build command per repo for stricter guarantees.
- **Manifests**: curate in `manifests/<vendor>/` and ship with the deploy. Treat manifest updates as a code deploy — they change what the agent does to customer code.

## 6. Roadmap beyond MVP

- Multi-tenant SaaS with billing and per-org app installs
- The 50-vendor manifest catalog (the moat — per-vendor curation)
- Detection-first reports (no write access) as a free tier; PRs as a paid tier
- White-label: vendor ships "their" migration agent to their customers
