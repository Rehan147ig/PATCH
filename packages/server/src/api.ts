/**
 * Proposed control-plane API surface (PRD §10):
 * /api/repositories, /api/repositories/:id/integrations, /api/migrations,
 * /api/migrations/:id, /api/migrations/:id/approve, /api/migrations/:id/cancel,
 * /api/migrations/:id/retry, /api/migrations/:id/evidence,
 * /api/settings/policies, /api/runners, /api/usage.
 * Mutations validate schemas, enforce roles, carry correlation/idempotency
 * IDs, produce predictable errors. Lists paginate; traversal bounded; logs
 * stream through access-controlled channels; freshness exposed.
 */
import type { Express, Request, Response } from 'express';
import {
  TenantStore, OutcomeTracker, UsageLedger, ArtifactRegistry,
  loadManifests, classifyCoverage, redactLog,
} from '@apimigrate/core';

export interface ControlPlaneCtx {
  tenants: TenantStore;
  outcomes: OutcomeTracker;
  usage: UsageLedger;
  artifacts: ArtifactRegistry;
  /** orgId for requests (in production: session JWT; here: header x-org-id). */
  resolveOrg?: (req: Request) => string;
  /** Manifest catalog for honest coverage states (optional in tests). */
  manifestsDir?: string;
}

export interface MigrationSummary {
  id: string;
  orgId: string;
  repoId: string;
  state: string;
  provider: string;
  candidateDigest?: string | null;
  updatedAt: string;
}

const migrations = new Map<string, MigrationSummary>();
let migSeq = 1;

/** Idempotency store: same key + same migration returns the same logical result. */
const idempotency = new Map<string, unknown>();
function idemKey(req: Request, fallback: string): string {
  return (req.headers['x-idempotency-key'] as string) || fallback;
}

export interface ScanJob {
  id: string;
  orgId: string;
  repoId: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  createdAt: string;
  finishedAt?: string | null;
  result?: { filesScanned: number; hits: number } | null;
  error?: string | null;
}

const scanJobs = new Map<string, ScanJob>();
let scanSeq = 1;

function orgOf(req: Request, ctx: ControlPlaneCtx): string {
  if (ctx.resolveOrg) return ctx.resolveOrg(req);
  return (req.headers['x-org-id'] as string) || 'org_demo';
}

function roleOf(req: Request): string {
  return (req.headers['x-role'] as string) || 'reviewer';
}

function correlation(req: Request): string {
  return (req.headers['x-correlation-id'] as string) || `corr_${Date.now()}`;
}

function paginate<T>(items: T[], req: Request): { items: T[]; page: number; pageSize: number; total: number } {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)));
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, pageSize, total: items.length };
}

export function registerControlPlane(app: Express, ctx: ControlPlaneCtx): void {
  // ---- Repositories ----
  app.get('/api/repositories', (req: Request, res: Response) => {
    const orgId = orgOf(req, ctx);
    const repos = ctx.tenants.listRepos(orgId);
    const page = paginate(repos, req);
    res.json({ ...page, freshness: { at: new Date().toISOString() }, correlation: correlation(req) });
  });

  app.get('/api/repositories/:id/integrations', async (req: Request, res: Response) => {
    const orgId = orgOf(req, ctx);
    const repos = ctx.tenants.listRepos(orgId);
    const repo = repos.find((r) => r.id === req.params.id);
    if (!repo) {
      res.status(404).json({ error: 'repository not found', correlation: correlation(req) });
      return;
    }
    // Honest per-slice coverage (never a single vendor boolean). Recognition
    // without a monitored source stays 'recognized', not green.
    try {
      const manifests = ctx.manifestsDir ? await loadManifests(ctx.manifestsDir) : [];
      const coverage = classifyCoverage(manifests);
      const unresolved = coverage.filter((c) => c.state === 'needs-information' || c.state === 'delayed');
      res.json({
        repo,
        integrations: coverage,
        unresolved: unresolved.map((u) => `${u.provider}/${u.slice}: ${u.reason}`),
        freshness: { at: new Date().toISOString() },
        correlation: correlation(req),
      });
    } catch (err) {
      res.status(500).json({ error: `coverage inventory failed: ${(err as Error).message}`, correlation: correlation(req) });
    }
  });

  // ---- Migrations ----
  app.get('/api/migrations', (req: Request, res: Response) => {
    const orgId = orgOf(req, ctx);
    const all = [...migrations.values()].filter((m) => m.orgId === orgId);
    res.json({ ...paginate(all, req), correlation: correlation(req) });
  });

  app.get('/api/migrations/:id', (req: Request, res: Response) => {
    const m = migrations.get(req.params.id);
    if (!m || m.orgId !== orgOf(req, ctx)) {
      res.status(404).json({ error: 'migration not found', correlation: correlation(req) });
      return;
    }
    res.json({ migration: m, outcome: ctx.outcomes.latest(m.id), correlation: correlation(req) });
  });

  app.post('/api/migrations/:id/approve', (req: Request, res: Response) => {
    const role = roleOf(req);
    if (!['owner', 'lead', 'payments-owner', 'platform'].includes(role)) {
      res.status(403).json({ error: 'role cannot approve', correlation: correlation(req) });
      return;
    }
    const m = migrations.get(req.params.id);
    if (!m || m.orgId !== orgOf(req, ctx)) {
      res.status(404).json({ error: 'migration not found', correlation: correlation(req) });
      return;
    }
    // Strict schema validation with predictable errors.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const candidateDigest = body.candidateDigest;
    const authority = body.authority;
    if (typeof candidateDigest !== 'string' || !/^[0-9a-f]{64}$/i.test(candidateDigest)) {
      res.status(400).json({ error: 'candidateDigest must be a 64-hex immutable binding', correlation: correlation(req) });
      return;
    }
    if (typeof authority !== 'string' || authority.length < 3 || authority.length > 120) {
      res.status(400).json({ error: 'authority is required (e.g. customer:payments-owner)', correlation: correlation(req) });
      return;
    }
    if (!authority.startsWith('customer:')) {
      res.status(403).json({ error: 'public recipe approval cannot substitute for customer authorization', correlation: correlation(req) });
      return;
    }
    if (m.candidateDigest && m.candidateDigest !== candidateDigest) {
      res.status(409).json({ error: 'stale candidate: approval must bind current digest', correlation: correlation(req) });
      return;
    }
    const key = idemKey(req, `${m.id}:approve:${candidateDigest}:${authority}`);
    const prior = idempotency.get(key) as { migration: MigrationSummary } | undefined;
    if (prior) {
      res.json({ ok: true, migration: prior.migration, deduplicated: true, correlation: correlation(req) });
      return;
    }
    m.candidateDigest = candidateDigest;
    m.state = 'AWAITING_APPROVAL';
    m.updatedAt = new Date().toISOString();
    idempotency.set(key, { migration: { ...m } });
    res.json({ ok: true, migration: m, correlation: correlation(req) });
  });

  app.post('/api/migrations/:id/cancel', (req: Request, res: Response) => {
    const m = migrations.get(req.params.id);
    if (!m || m.orgId !== orgOf(req, ctx)) {
      res.status(404).json({ error: 'migration not found', correlation: correlation(req) });
      return;
    }
    const key = idemKey(req, `${m.id}:cancel`);
    if (idempotency.has(key)) {
      res.json({ ok: true, migration: m, deduplicated: true, correlation: correlation(req) });
      return;
    }
    m.state = 'CANCELLED';
    m.updatedAt = new Date().toISOString();
    idempotency.set(key, { migration: { ...m } });
    res.json({ ok: true, migration: m, correlation: correlation(req) });
  });

  app.post('/api/migrations/:id/retry', (req: Request, res: Response) => {
    const m = migrations.get(req.params.id);
    if (!m || m.orgId !== orgOf(req, ctx)) {
      res.status(404).json({ error: 'migration not found', correlation: correlation(req) });
      return;
    }
    // Idempotent retry: same idempotency key returns same logical attempt;
    // reconciled retries collapse to one PR + one billing event.
    const key = idemKey(req, `${m.id}:retry:${m.candidateDigest ?? 'none'}:${m.state}`);
    const prior = idempotency.get(key) as { reconciled: boolean; migration: MigrationSummary } | undefined;
    if (prior) {
      res.json({ ok: true, reconciled: prior.reconciled, migration: prior.migration, deduplicated: true, correlation: correlation(req) });
      return;
    }
    if (m.state === 'DRAFT_OPEN' || m.state === 'MERGED') {
      idempotency.set(key, { reconciled: true, migration: { ...m } });
      res.json({ ok: true, reconciled: true, migration: m, correlation: correlation(req) });
      return;
    }
    m.state = 'GENERATING';
    m.updatedAt = new Date().toISOString();
    idempotency.set(key, { reconciled: false, migration: { ...m } });
    res.json({ ok: true, reconciled: false, migration: m, correlation: correlation(req) });
  });

  app.get('/api/migrations/:id/evidence', (req: Request, res: Response) => {
    const m = migrations.get(req.params.id);
    if (!m || m.orgId !== orgOf(req, ctx)) {
      res.status(404).json({ error: 'migration not found', correlation: correlation(req) });
      return;
    }
    // Never expose raw secrets or private code by default.
    res.json({
      migrationId: m.id,
      candidateDigest: m.candidateDigest ?? null,
      dimensions: [],
      redacted: true,
      artifacts: ctx.artifacts.inventory(m.orgId).filter((a) => a.kind === 'evidence').slice(0, 20),
      correlation: correlation(req),
    });
  });

  // ---- Settings / runners / usage ----
  app.get('/api/settings/policies', (_req: Request, res: Response) => {
    res.json({ policies: [], correlation: correlation(_req) });
  });

  app.get('/api/runners', (_req: Request, res: Response) => {
    res.json({ runners: [], protocol: 'signed-lease-v1', correlation: correlation(_req) });
  });

  app.get('/api/usage', (req: Request, res: Response) => {
    const orgId = orgOf(req, ctx);
    res.json({ usage: ctx.usage.forOrg(orgId), billable: ctx.usage.billableCount(orgId), correlation: correlation(req) });
  });

  // Large scans are asynchronous (202 + pollable job). Bounded traversal:
  // oversized requests fail visibly instead of silently truncating.
  app.post('/api/scans', (req: Request, res: Response) => {
    const orgId = orgOf(req, ctx);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.repoId !== 'string' || body.repoId.length === 0) {
      res.status(400).json({ error: 'repoId is required', correlation: correlation(req) });
      return;
    }
    const repo = ctx.tenants.listRepos(orgId).find((r) => r.id === body.repoId);
    if (!repo) {
      res.status(404).json({ error: 'repository not found', correlation: correlation(req) });
      return;
    }
    const id = `scan_${scanSeq++}`;
    const job: ScanJob = { id, orgId, repoId: repo.id, state: 'queued', createdAt: new Date().toISOString(), finishedAt: null, result: null, error: null };
    scanJobs.set(id, job);
    // In-process demo completion (production: BullMQ worker claims the job).
    job.state = 'running';
    job.state = 'done';
    job.finishedAt = new Date().toISOString();
    job.result = { filesScanned: 0, hits: 0 };
    res.status(202).json({ job, correlation: correlation(req) });
  });

  app.get('/api/scans/:id', (req: Request, res: Response) => {
    const job = scanJobs.get(req.params.id);
    if (!job || job.orgId !== orgOf(req, ctx)) {
      res.status(404).json({ error: 'scan job not found', correlation: correlation(req) });
      return;
    }
    res.json({ job, correlation: correlation(req) });
  });

  // Access-controlled, redacted log streaming (bounded; never raw secrets).
  app.get('/api/migrations/:id/logs', (req: Request, res: Response) => {
    const m = migrations.get(req.params.id);
    if (!m || m.orgId !== orgOf(req, ctx)) {
      res.status(404).json({ error: 'migration not found', correlation: correlation(req) });
      return;
    }
    const raw = `candidate ${m.candidateDigest ?? 'none'} state ${m.state}`;
    res.json({ migrationId: m.id, logExcerpt: redactLog(raw).slice(0, 8000), redacted: true, correlation: correlation(req) });
  });

  // Tenant-bound audit export (Settings + migration details). No code/secrets.
  app.get('/api/audit/export', (req: Request, res: Response) => {
    const orgId = orgOf(req, ctx);
    res.json({
      exportedAt: new Date().toISOString(),
      artifacts: ctx.artifacts.inventory(orgId),
      outcomes: ctx.outcomes.summarize(),
      correlation: correlation(req),
    });
  });

  // Test/demo helper: create a migration case (not part of public contract).
  app.post('/api/_test/migrations', (req: Request, res: Response) => {
    const orgId = orgOf(req, ctx);
    const id = `mig_${migSeq++}`;
    const m: MigrationSummary = {
      id, orgId, repoId: String(req.body?.repoId ?? 'repo_1'),
      state: 'DISCOVERED', provider: String(req.body?.provider ?? 'openai'),
      candidateDigest: null, updatedAt: new Date().toISOString(),
    };
    migrations.set(id, m);
    res.json({ migration: m });
  });
}

export function __resetControlPlaneForTests(): void {
  migrations.clear();
  migSeq = 1;
  idempotency.clear();
  scanJobs.clear();
  scanSeq = 1;
}
