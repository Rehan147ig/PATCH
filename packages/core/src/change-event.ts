/**
 * FR-04 + §5 change intelligence. Stores the ChangeEvent contract, monitors
 * official sources with conditional fetch / retry / hashes / corrections /
 * effective dates / provenance / freshness. Scenarios 5 (spec change without
 * package bump → applicable contract change detected, additive stays quiet),
 * 6 (fake change rejected — see security.ts recipe verification), 18 (feed
 * outage → freshness warning, bounded retry, no duplicated alerts).
 */
import { createHash } from 'node:crypto';

export type ProviderChangeKind =
  | 'api-contract-break' | 'sdk-incompatibility' | 'endpoint-retirement'
  | 'model-retirement' | 'default-behavior-change' | 'auth-requirement'
  | 'webhook-change' | 'rate-limit-policy' | 'security-notice' | 'optional-feature';

export type DatePrecision = 'confirmed' | 'earliest-possible' | 'historical';

export interface ChangeEvent {
  id: string;
  provider: string;
  product?: string;
  hostingPlatform?: string;
  region?: string;
  kind: ProviderChangeKind;
  sourceUrl: string;
  retrievedAt: string;
  publishedAt?: string | null;
  effectiveDate?: string | null;
  datePrecision: DatePrecision;
  sourceDigest: string;
  previousDigest?: string | null;
  affectedRange?: string | null;
  targetVersions?: string[];
  evidenceExcerpts: string[];
  reviewerProvenance?: string | null;
  supersedes?: string | null;
  correctionOf?: string | null;
  /** Licensed metadata preserved as excerpt refs, never full redistribution. */
  licenseRef?: string | null;
  /** Tenant-scoped when true (private guidance); otherwise public-shared. */
  tenantScoped?: boolean;
}

export function sha256Hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Build a ChangeEvent from fetched source material (LLM-extracted facts must
 * still pass deterministic checks before promotion — see promoteEvent). */
export function buildChangeEvent(input: Omit<ChangeEvent, 'id' | 'sourceDigest' | 'retrievedAt'> & {
  rawBody: string; retrievedAt?: string; id?: string;
}): ChangeEvent {
  const retrievedAt = input.retrievedAt ?? new Date().toISOString();
  const sourceDigest = sha256Hex(input.rawBody);
  return {
    id: input.id ?? `chg_${sourceDigest.slice(0, 12)}`,
    provider: input.provider, product: input.product, hostingPlatform: input.hostingPlatform,
    region: input.region, kind: input.kind, sourceUrl: input.sourceUrl,
    retrievedAt, publishedAt: input.publishedAt ?? null,
    effectiveDate: input.effectiveDate ?? null, datePrecision: input.datePrecision,
    sourceDigest, previousDigest: input.previousDigest ?? null,
    affectedRange: input.affectedRange ?? null, targetVersions: input.targetVersions ?? [],
    evidenceExcerpts: input.evidenceExcerpts.slice(0, 5),
    reviewerProvenance: input.reviewerProvenance ?? null,
    supersedes: input.supersedes ?? null, correctionOf: input.correctionOf ?? null,
    licenseRef: input.licenseRef ?? null, tenantScoped: input.tenantScoped ?? false,
  };
}

/** Deterministic promotion gate: schema validity alone never promotes. */
export function canPromote(candidates: { hasSourceDigest: boolean; deterministicCheck: boolean; maintainerReview?: boolean }): boolean {
  if (!candidates.hasSourceDigest) return false;
  return candidates.deterministicCheck || candidates.maintainerReview === true;
}

/** Confirmed retirement vs earliest-possible vs already-retired (historical). */
export function deadlineStatus(ev: Pick<ChangeEvent, 'effectiveDate' | 'datePrecision'>, at = Date.now()): 'upcoming' | 'earliest-possible' | 'historical' | 'unknown' {
  if (!ev.effectiveDate) return 'unknown';
  const t = Date.parse(ev.effectiveDate);
  if (isNaN(t)) return 'unknown';
  if (ev.datePrecision === 'historical' || t <= at) return 'historical';
  return ev.datePrecision === 'confirmed' ? 'upcoming' : 'earliest-possible';
}

// ---- Feed monitoring (conditional fetch, backoff, freshness, dedup) ----

export interface FetchResult { status: number; body: string; etag?: string; lastModified?: string }
export type Fetcher = (url: string, headers: Record<string, string>) => Promise<FetchResult>;

export interface FeedState {
  url: string;
  etag?: string;
  lastModified?: string;
  lastDigest?: string;
  lastSuccessAt?: number;
  consecutiveFailures: number;
  emittedDigests: Set<string>;
}

export const MAX_FETCH_RETRIES = 5;
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

export async function pollFeed(
  state: FeedState, fetcher: Fetcher, at = Date.now(),
  opts: { maxRetries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ state: FeedState; changed: boolean; digest?: string; body?: string; notModified?: boolean; error?: string }> {
  const maxRetries = opts.maxRetries ?? MAX_FETCH_RETRIES;
  const sleepFn = opts.sleep ?? sleep;
  const headers: Record<string, string> = {};
  if (state.etag) headers['If-None-Match'] = state.etag;
  if (state.lastModified) headers['If-Modified-Since'] = state.lastModified;
  let lastError = 'unknown';
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetcher(state.url, headers);
      if (res.status === 304) {
        return { state: { ...state, consecutiveFailures: 0 }, changed: false, notModified: true };
      }
      if (res.status >= 500 || res.status === 429) {
        lastError = `retryable ${res.status}`;
        await sleepFn(backoffMs(attempt));
        continue;
      }
      if (res.status >= 400) return { state: { ...state, consecutiveFailures: state.consecutiveFailures + 1 }, changed: false, error: `http ${res.status}` };
      const digest = sha256Hex(res.body);
      const next: FeedState = {
        ...state, etag: res.etag ?? state.etag, lastModified: res.lastModified ?? state.lastModified,
        lastDigest: digest, lastSuccessAt: at, consecutiveFailures: 0, emittedDigests: new Set(state.emittedDigests),
      };
      if (next.emittedDigests.has(digest)) {
        return { state: next, changed: false, digest }; // no duplicated alerts (scenario 18)
      }
      next.emittedDigests.add(digest);
      return { state: next, changed: digest !== state.lastDigest, digest, body: res.body };
    } catch (err) {
      lastError = (err as Error).message;
      await sleepFn(backoffMs(attempt));
    }
  }
  return { state: { ...state, consecutiveFailures: state.consecutiveFailures + 1 }, changed: false, error: `bounded retry exhausted: ${lastError}` };
}

/** Freshness: detection within configured interval + 5min for healthy feeds. */
export function freshnessStatus(state: FeedState, intervalMs: number, at = Date.now()): { fresh: boolean; warning?: string } {
  if (!state.lastSuccessAt) return { fresh: false, warning: 'feed never succeeded; monitoring delayed' };
  const age = at - state.lastSuccessAt;
  if (age > intervalMs + 5 * 60 * 1000) {
    return { fresh: false, warning: `source stale: last success ${new Date(state.lastSuccessAt).toISOString()}` };
  }
  return { fresh: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
