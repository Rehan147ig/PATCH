import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInstallationOctokit, createMigrationPr, verifyWebhookSignature, type GitHubAppConfig } from './github.js';
import {
  loadManifests,
  scanDirectory,
  planCodemods,
  summarize,
  verifyCandidate,
  computeCandidateDigest,
  branchNameForDigest,
  gateDelivery,
  type ScanReport,
  type MigrationManifest,
} from '@apimigrate/core';

/**
 * The apimigrate GitHub App server.
 *
 * Webhooks:
 *  - `repository.installed` — run an initial scan on the new repo
 *  - `repository_dispatch` with event_type `apimigrate/scan` — run a scan on demand
 *
 * REST API (dashboard):
 *  - GET  /api/overview            — executive metrics
 *  - GET  /api/manifests           — vendor manifest catalog
 *  - POST /api/scan                — trigger a local scan against a repo dir
 *  - GET  /api/reports/latest      — latest scan reports
 *  - GET  /api/telemetry           — sunset/deprecation radar entries
 *  - POST /api/ingest/openapi      — diff two OpenAPI specs into a manifest
 *
 * Static: the web dashboard is served from packages/web/public.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_PUBLIC = process.env.APIMIGRATE_WEB_PUBLIC ?? path.resolve(__dirname, '../../web/public');

export function createServer(config: GitHubAppConfig, manifestsDir: string, opts: { repoDir?: string } = {}) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // In-memory state for the dashboard.
  let latestReports: ScanReport[] = [];
  let lastScanAt: string | null = null;

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // ---- REST API ----

  app.get('/api/overview', async (_req, res) => {
    try {
      const manifests = await loadManifests(manifestsDir);
      const summary = summarize(latestReports);
      const vendors = new Set(manifests.map((m) => m.vendor));
      res.json({
        vendorsTracked: vendors.size,
        totalManifests: manifests.length,
        activeDrifts: summary.totalHits,
        autoRemediated: summary.autoFixable,
        riskSpectrum: { low: summary.low, medium: summary.medium, high: summary.high },
        affectedFiles: summary.totalFiles,
        services: summary.services,
        lastScanAt,
        reports: latestReports.map((r) => ({
          manifestId: r.manifest.id,
          vendor: r.manifest.vendor,
          title: r.manifest.title,
          severity: r.manifest.severity,
          hits: r.hits.length,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/manifests', async (_req, res) => {
    try {
      const manifests = await loadManifests(manifestsDir);
      res.json({ manifests });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/reports/latest', (_req, res) => {
    res.json({ reports: latestReports, scannedAt: lastScanAt });
  });

  app.get('/api/telemetry', async (_req, res) => {
    try {
      const manifests = await loadManifests(manifestsDir);
      const rules = manifests.flatMap((m) =>
        m.changes
          .filter((c) => c.match?.telemetry || c.match?.endpoint)
          .map((c) => ({
            vendor: m.vendor,
            changeType: c.type,
            description: c.description,
            match: c.match,
            changedAt: m.changedAt,
            severity: m.severity,
          })),
      );
      // Approaching-sunset detection: manifests with changedAt within 90 days.
      const now = Date.now();
      const approaching = manifests
        .filter((m) => {
          const t = Date.parse(m.changedAt);
          return !isNaN(t) && t - now < 90 * 24 * 60 * 60 * 1000 && t > now;
        })
        .map((m) => ({ id: m.id, vendor: m.vendor, changedAt: m.changedAt }));
      res.json({ rules, approachingSunset: approaching });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/scan', async (req, res) => {
    try {
      const repoDir = req.body.repoDir ?? opts.repoDir;
      if (!repoDir) {
        res.status(400).json({ error: 'repoDir is required' });
        return;
      }
      const manifests = await loadManifests(manifestsDir);
      const services = req.body.services as string[] | undefined;
      const reports = await scanDirectory(path.resolve(repoDir), manifests, { services });
      latestReports = reports;
      lastScanAt = new Date().toISOString();
      const summary = summarize(reports, services);
      res.json({ reports, summary, scannedAt: lastScanAt });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/ingest/openapi', async (req, res) => {
    try {
      const { oldSpec, newSpec, vendor, title, changedAt, sourceContract } = req.body;
      if (!oldSpec || !newSpec || !vendor || !changedAt) {
        res.status(400).json({ error: 'oldSpec, newSpec, vendor, and changedAt are required' });
        return;
      }
      const { compileManifest, diffOpenApi } = await import('@apimigrate/ingester');
      const diff = diffOpenApi(oldSpec, newSpec);
      const manifest = compileManifest(diff, {
        vendor,
        title: title ?? `${vendor} contract changes`,
        changedAt,
        sourceContract,
      });
      res.json({ manifest, diff });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ---- Webhooks ----

  app.post('/webhook', async (req, res) => {
    const body = JSON.stringify(req.body);
    if (config.webhookSecret) {
      const sig = req.headers['x-hub-signature-256'] as string | undefined;
      if (!verifyWebhookSignature(config.webhookSecret, body, sig)) {
        res.status(401).json({ error: 'invalid signature' });
        return;
      }
    }

    const event = req.headers['x-github-event'] as string | undefined;
    const payload = req.body;

    try {
      if (event === 'repository' && payload.action === 'created') {
        const { owner, name } = payload.repository;
        await handleScan(owner.login, name, config, manifestsDir);
        res.status(202).json({ accepted: true });
        return;
      }

      if (event === 'repository_dispatch' && payload.action === 'apimigrate/scan') {
        const { owner, name } = payload.repository;
        await handleScan(owner.login, name, config, manifestsDir);
        res.status(202).json({ accepted: true });
        return;
      }

      res.status(200).json({ ok: true, ignored: true });
    } catch (err) {
      console.error('webhook handler failed:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ---- Static dashboard ----

  app.use(express.static(WEB_PUBLIC));

  return app;
}

async function handleScan(owner: string, repo: string, config: GitHubAppConfig, manifestsDir: string) {
  const manifests = await loadManifests(manifestsDir);
  const octokit = await createInstallationOctokit(config, owner, repo);
  // For MVP: scan the default branch's code via the git API (tree + blobs).
  const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: 'heads/main' });
  const sha = ref.object.sha;
  const { data: tree } = await octokit.rest.git.getTree({ owner, repo, tree_sha: sha, recursive: '1' });
  const codeFiles = (tree.tree ?? [])
    .filter((f) => f.type === 'blob' && /\.(ts|tsx|js|jsx|mjs|cjs|json)$/.test(f.path ?? ''))
    .slice(0, 200);

  // Fetch file contents.
  const contents: Array<{ path: string; content: string }> = [];
  for (const f of codeFiles) {
    if (!f.path || !f.sha) continue;
    try {
      const { data: blob } = await octokit.rest.git.getBlob({ owner, repo, file_sha: f.sha });
      contents.push({ path: f.path, content: Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8') });
    } catch {
      // skip unreadable blobs
    }
  }

  // Write to a temp dir and scan.
  const tmp = path.join(process.cwd(), '.apimigrate-tmp');
  await fs.mkdir(tmp, { recursive: true });
  for (const { path: p, content } of contents) {
    const target = path.join(tmp, p);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }

  const reports = await scanDirectory(tmp, manifests);
  const plan = planCodemods(reports, tmp);

  if (plan.changedFiles.size === 0) {
    return;
  }

  // FR-08/FR-10: verify the candidate and gate automatic delivery. The
  // server flow has no human approval, so INCOMPLETE/FAILED candidates never
  // open a PR automatically. Freshness holds by construction here: validation
  // ran in this process on these exact files, and createMigrationPr re-reads
  // the live base SHA when cutting the branch. The remote base SHA fetched
  // above is the known baseline.
  const run = await verifyCandidate(tmp, plan.changedFiles, reports);
  const gate = gateDelivery({
    verdict: run.verdict,
    fresh: true,
    baselineKnown: sha.length > 0,
    explicitApproval: false,
  });
  if (!gate.ok) {
    console.log(`apimigrate: automatic delivery blocked (${run.verdict}): ${gate.reason}`);
    return;
  }

  const { digest } = await computeCandidateDigest(plan.changedFiles, reports);
  const body = `${buildBody(reports)}\n\ncandidate: \`${digest.slice(0, 12)}\``;
  await createMigrationPr(octokit, owner, repo, {
    base: 'main',
    head: branchNameForDigest(digest),
    title: 'chore(apimigrate): apply API migration',
    body,
    changedFiles: plan.changedFiles,
    candidateDigest: digest,
  });
}

function buildBody(reports: Awaited<ReturnType<typeof scanDirectory>>): string {
  const lines = ['## Auto-generated API migration', ''];
  for (const r of reports) {
    lines.push(`### ${r.manifest.vendor}: ${r.manifest.title}`, '');
    lines.push(`Severity: **${r.manifest.severity}** — effective ${r.manifest.changedAt}`);
    lines.push('');
    lines.push(`Affected usages: **${r.hits.length}**`, '');
    lines.push('| File | Line | Kind | Status |');
    lines.push('| --- | --- | --- | --- |');
    for (const h of r.hits.slice(0, 25)) {
      const status = h.replacement && h.replacement !== h.snippet ? 'fixed' : 'manual';
      lines.push(`| ${h.file} | ${h.line} | ${h.kind} | ${status} |`);
    }
    lines.push('');
  }
  lines.push('---', 'Review before merging.');
  return lines.join('\n');
}
