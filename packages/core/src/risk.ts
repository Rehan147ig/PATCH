import type { BlastRadius, ChangeSeverity, ManifestChange, RiskRating, ScanHit, ScanReport } from './types.js';

/**
 * Deterministic risk matrix.
 *
 * Base score comes from the change kind; modifiers:
 *  - manifest severity (breaking > deprecation > feature)
 *  - fix availability (mechanical fix lowers risk; report-only raises it)
 *  - confidence (low-confidence matches raise risk)
 *  - explicit manifest `risk` overrides everything
 *
 * Score bands: < 40 LOW, 40-69 MEDIUM, >= 70 HIGH.
 */
export function scoreChange(
  change: ManifestChange,
  opts: { confidence?: number; hasFix?: boolean; severity?: ChangeSeverity } = {},
): number {
  if (change.risk) {
    return ratingToScore(change.risk);
  }

  const kindBase: Record<string, number> = {
    'renamed-call': 45,
    'renamed-field': 40,
    'renamed-parameter': 35,
    'removed-parameter': 60,
    'changed-parameter-type': 65,
    'removed-field': 65,
    'renamed-enum-value': 55,
    'sdk-upgrade': 50,
    'deprecated-call': 45,
    'endpoint-removed': 75,
    'endpoint-deprecated': 40,
    'response-field-changed': 60,
    'request-field-changed': 60,
  };
  let score = kindBase[change.type] ?? 50;

  if (opts.severity === 'breaking') score += 20;
  else if (opts.severity === 'deprecation') score -= 10;

  if (opts.hasFix) score -= 15;
  if (opts.confidence !== undefined) {
    if (opts.confidence < 0.6) score += 15;
    else if (opts.confidence < 0.8) score += 8;
  }

  return clamp(score, 0, 100);
}

export function scoreToRating(score: number): RiskRating {
  if (score >= 70) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

export function ratingToScore(rating: RiskRating): number {
  return rating === 'HIGH' ? 80 : rating === 'MEDIUM' ? 55 : 25;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Compute the risk rating for a change (respecting an explicit override). */
export function riskForChange(
  change: ManifestChange,
  opts: { confidence?: number; hasFix?: boolean; severity?: ChangeSeverity } = {},
): RiskRating {
  if (change.risk) return change.risk;
  return scoreToRating(scoreChange(change, opts));
}

/** Compute blast radius for a report's hits. */
export function computeBlastRadius(report: ScanReport, services?: string[]): BlastRadius {
  const files = new Set<string>();
  let callSites = 0;
  for (const hit of report.hits) {
    files.add(hit.file);
    callSites++;
  }
  return {
    fileCount: files.size,
    callSiteCount: callSites,
    affectedFiles: [...files].slice(0, 20),
    affectedServices: services,
  };
}

/** Aggregate risk for a full report (max of per-change ratings). */
export function aggregateRisk(report: ScanReport): RiskRating {
  let worst = 0;
  for (const hit of report.hits) {
    const score = hit.risk ? ratingToScore(hit.risk) : scoreChange(report.manifest.changes[hit.changeIndex] ?? {
      type: hit.kind,
      description: '',
    }, { confidence: hit.confidence, hasFix: !!hit.fix, severity: report.manifest.severity });
    worst = Math.max(worst, score);
  }
  return scoreToRating(worst);
}

/** Apply risk + blast radius to every hit in a report (mutating). */
export function annotateReport(report: ScanReport, services?: string[]): ScanReport {
  const blast = computeBlastRadius(report, services);
  for (const hit of report.hits) {
    const change = report.manifest.changes[hit.changeIndex];
    hit.risk = riskForChange(change ?? { type: hit.kind, description: '' }, {
      confidence: hit.confidence,
      hasFix: !!hit.fix,
      severity: report.manifest.severity,
    });
    hit.blastRadius = blast;
  }
  report.manifest.changes.forEach((c) => {
    if (!c.risk) c.risk = riskForChange(c, { severity: report.manifest.severity });
  });
  return report;
}

/** Summarize a set of annotated reports for the dashboard. */
export interface RiskSummary {
  totalHits: number;
  totalFiles: number;
  low: number;
  medium: number;
  high: number;
  /** Count of hits with a mechanical fix available. */
  autoFixable: number;
  services: string[];
}

export function summarize(reports: ScanReport[], services: string[] = []): RiskSummary {
  const files = new Set<string>();
  let low = 0;
  let medium = 0;
  let high = 0;
  let autoFixable = 0;
  let totalHits = 0;
  for (const report of reports) {
    for (const hit of report.hits) {
      totalHits++;
      files.add(hit.file);
      const rating = hit.risk ?? riskForChange(report.manifest.changes[hit.changeIndex] ?? { type: hit.kind, description: '' }, {
        confidence: hit.confidence,
        hasFix: !!hit.fix,
      });
      if (rating === 'HIGH') high++;
      else if (rating === 'MEDIUM') medium++;
      else low++;
      if (hit.fix && hit.replacement) autoFixable++;
    }
  }
  return { totalHits, totalFiles: files.size, low, medium, high, autoFixable, services };
}
