import { describe, it, expect } from 'vitest';
import {
  scoreChange,
  riskForChange,
  aggregateRisk,
  annotateReport,
  summarize,
  computeBlastRadius,
} from '../src/risk.js';
import type { MigrationManifest, ScanReport } from '../src/types.js';

const manifest = (overrides: Partial<MigrationManifest> = {}): MigrationManifest => ({
  schemaVersion: '1.0',
  id: 'test',
  vendor: 'stripe',
  title: 't',
  severity: 'breaking',
  lang: 'typescript',
  changedAt: '2026-01-01',
  changes: [],
  ...overrides,
});

describe('risk engine', () => {
  it('scores a removed endpoint as HIGH', () => {
    const score = scoreChange({ type: 'endpoint-removed', description: 'gone' }, { severity: 'breaking' });
    expect(score).toBeGreaterThanOrEqual(70);
    expect(riskForChange({ type: 'endpoint-removed', description: 'gone' }, { severity: 'breaking' })).toBe('HIGH');
  });

  it('scores a mechanical rename with a fix as MEDIUM or lower', () => {
    const score = scoreChange(
      { type: 'renamed-call', description: 'rename', fix: { kind: 'rename-call', from: 'a', to: 'b' } },
      { severity: 'deprecation', hasFix: true, confidence: 0.95 },
    );
    expect(score).toBeLessThan(40);
    expect(riskForChange({ type: 'renamed-call', description: 'r' }, { severity: 'deprecation', hasFix: true })).toBe('LOW');
  });

  it('respects an explicit risk override', () => {
    expect(riskForChange({ type: 'renamed-call', description: 'r', risk: 'HIGH' }, { hasFix: true })).toBe('HIGH');
  });

  it('computes blast radius from hits', () => {
    const report: ScanReport = {
      manifest: manifest(),
      filesScanned: 2,
      durationMs: 1,
      hits: [
        { manifestId: 'm', changeIndex: 0, kind: 'renamed-call', file: 'a.ts', line: 1, column: 1, snippet: 'x', confidence: 0.9 },
        { manifestId: 'm', changeIndex: 0, kind: 'renamed-call', file: 'a.ts', line: 5, column: 1, snippet: 'x', confidence: 0.9 },
        { manifestId: 'm', changeIndex: 0, kind: 'renamed-call', file: 'b.ts', line: 2, column: 1, snippet: 'x', confidence: 0.9 },
      ],
    };
    const blast = computeBlastRadius(report, ['payments']);
    expect(blast.fileCount).toBe(2);
    expect(blast.callSiteCount).toBe(3);
    expect(blast.affectedServices).toEqual(['payments']);
  });

  it('annotates hits with risk and blast radius', () => {
    const report: ScanReport = {
      manifest: manifest({
        changes: [{ type: 'endpoint-removed', description: 'gone' }],
      }),
      filesScanned: 1,
      durationMs: 1,
      hits: [
        { manifestId: 'm', changeIndex: 0, kind: 'endpoint-removed', file: 'a.ts', line: 1, column: 1, snippet: 'x', confidence: 0.9 },
      ],
    };
    annotateReport(report);
    expect(report.hits[0].risk).toBe('HIGH');
    expect(report.hits[0].blastRadius?.fileCount).toBe(1);
    expect(aggregateRisk(report)).toBe('HIGH');
  });

  it('summarizes risk distribution', () => {
    const report: ScanReport = {
      manifest: manifest({
        changes: [
          { type: 'renamed-call', description: 'r', fix: { kind: 'rename-call', from: 'a', to: 'b' } },
          { type: 'endpoint-removed', description: 'g' },
        ],
      }),
      filesScanned: 1,
      durationMs: 1,
      hits: [
        { manifestId: 'm', changeIndex: 0, kind: 'renamed-call', file: 'a.ts', line: 1, column: 1, snippet: 'x', confidence: 0.95, fix: { kind: 'rename-call', from: 'a', to: 'b' }, replacement: 'y' },
        { manifestId: 'm', changeIndex: 1, kind: 'endpoint-removed', file: 'a.ts', line: 3, column: 1, snippet: 'x', confidence: 0.9 },
      ],
    };
    annotateReport(report);
    const summary = summarize([report]);
    expect(summary.totalHits).toBe(2);
    expect(summary.autoFixable).toBe(1);
    expect(summary.high).toBeGreaterThanOrEqual(1);
  });
});
