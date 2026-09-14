/**
 * Canonical capability key (§10): provider + product + hosting platform +
 * language + source range + target range + change family + extractor +
 * transform + validation profile. Benchmark artifacts + expiration/review
 * conditions stored alongside. Never certify an entire vendor from one fixture.
 */

export interface CapabilityKey {
  provider: string;
  product?: string;
  hostingPlatform?: string;
  language: string;
  sourceRange?: string | null;
  targetRange?: string | null;
  changeFamily: string;
  extractor: string;
  transform: string;
  validationProfile: string;
}

export function capabilityKey(k: CapabilityKey): string {
  return [
    k.provider, k.product ?? '*', k.hostingPlatform ?? '*', k.language,
    k.sourceRange ?? '*', k.targetRange ?? '*', k.changeFamily,
    k.extractor, k.transform, k.validationProfile,
  ].join('|');
}

export interface CapabilityRecord {
  key: string;
  status: 'qualified' | 'provisional' | 'retired';
  benchmarkRef?: string;
  expiresAt?: string | null;
  reviewNote?: string;
  /** Denominators behind precision/recall claims (never a bare percentage). */
  evaluation?: { positives: number; negatives: number; ambiguous: number; repos: number };
}

export function meetsLaunchThreshold(e: { positives: number; negatives: number; ambiguous: number; repos: number }): boolean {
  return e.positives >= 30 && e.negatives >= 30 && e.ambiguous >= 20 && e.repos >= 5;
}
