/**
 * Coverage honesty (§2/§3/G3): per provider-slice states, never a single
 * vendor boolean. A provider can have maintained REST methods and unresolved
 * webhooks simultaneously. Recognition ≠ monitoring ≠ repair promise.
 */
import type { MigrationManifest } from './types.js';

export type CoverageState = 'maintained' | 'monitored' | 'recognized' | 'needs-information' | 'delayed';

export interface SliceCoverage {
  provider: string;
  slice: string;
  state: CoverageState;
  reason: string;
  manifestId?: string | null;
  effectiveDate?: string | null;
}

/** Qualified change families for the four-provider launch target (G3).
 * Only families with qualified matching + patching + verification are listed.
 * Anthropic/Gemini remain monitored (reliable detection, no automated repair
 * claim) until their families pass the §13 thresholds — a bare identifier
 * never satisfies G3. */
const QUALIFIED_SLICES = new Set([
  'openai|chat-completions',
  'openai|responses',
  'stripe|skus',
  'stripe|charges',
  'stripe|api-version-pin',
]);

function sliceOf(manifestId: string, vendor: string): string {
  const id = manifestId.toLowerCase();
  if (vendor === 'openai') {
    if (id.includes('chat')) return 'chat-completions';
    if (id.includes('response')) return 'responses';
    return 'api';
  }
  if (vendor === 'stripe') {
    if (id.includes('sku')) return 'skus';
    if (id.includes('amount') || id.includes('charge')) return 'charges';
    if (id.includes('version-pin')) return 'api-version-pin';
    return 'api';
  }
  if (vendor === 'anthropic' && id.includes('message')) return 'messages';
  if (vendor === 'gemini' && id.includes('generate')) return 'generate-content';
  return 'api';
}

export function classifyCoverage(
  manifests: MigrationManifest[],
  opts: { staleVendors?: Set<string>; needsInfo?: Set<string> } = {},
): SliceCoverage[] {
  const out: SliceCoverage[] = [];
  for (const m of manifests) {
    const slice = sliceOf(m.id, m.vendor);
    const key = `${m.vendor}|${slice}`;
    let state: CoverageState = 'monitored';
    let reason = 'reliable change monitoring and impact assessment; automated repair may not exist';
    if (QUALIFIED_SLICES.has(key)) {
      state = 'maintained';
      reason = 'matching, patching, and required verification qualified for listed transitions';
    }
    if (opts.staleVendors?.has(m.vendor)) {
      state = 'delayed';
      reason = 'sources or scans are stale; last successful state timestamped';
    } else if (opts.needsInfo?.has(`${m.vendor}|${slice}`) || opts.needsInfo?.has(m.vendor)) {
      state = 'needs-information';
      reason = 'external version/configuration or ambiguous usage prevents a conclusion';
    }
    out.push({ provider: m.vendor, slice, state, reason, manifestId: m.id, effectiveDate: m.changedAt });
  }
  return out;
}

/** Unknown providers: recognized identity only — never a green health verdict. */
export function recognizedOnly(provider: string, detail: string): SliceCoverage {
  return {
    provider, slice: 'unknown', state: 'recognized',
    reason: `integration identity detected (${detail}); reliable monitored source or mapper absent — not a repair promise`,
  };
}
