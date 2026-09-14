import { describe, it, expect } from 'vitest';
import { buildChangeEvent, deadlineStatus, pollFeed, freshnessStatus, type FeedState } from './change-event.js';

describe('§5 ChangeEvent contract', () => {
  it('distinguishes confirmed vs earliest-possible vs historical deadlines', () => {
    const future = new Date(Date.now() + 86400000 * 30).toISOString();
    const past = new Date(Date.now() - 86400000).toISOString();
    const mk = (effectiveDate: string | null, datePrecision: 'confirmed' | 'earliest-possible' | 'historical' = 'confirmed') =>
      buildChangeEvent({
        provider: 'stripe', kind: 'endpoint-retirement', sourceUrl: 'https://stripe.com/docs',
        effectiveDate, datePrecision, evidenceExcerpts: ['sunset'], rawBody: effectiveDate ?? 'x',
      });
    expect(deadlineStatus(mk(future, 'confirmed'))).toBe('upcoming');
    expect(deadlineStatus(mk(future, 'earliest-possible'))).toBe('earliest-possible');
    expect(deadlineStatus(mk(past))).toBe('historical');
    expect(deadlineStatus(mk(null))).toBe('unknown');
  });

  it('chains corrections without losing provenance', () => {
    const v1 = buildChangeEvent({ provider: 'openai', kind: 'model-retirement', sourceUrl: 'https://x', effectiveDate: null, datePrecision: 'confirmed', evidenceExcerpts: ['a'], rawBody: 'v1' });
    const v2 = buildChangeEvent({ provider: 'openai', kind: 'model-retirement', sourceUrl: 'https://x', effectiveDate: null, datePrecision: 'confirmed', evidenceExcerpts: ['b'], rawBody: 'v2', correctionOf: v1.id, previousDigest: v1.sourceDigest });
    expect(v2.correctionOf).toBe(v1.id);
    expect(v2.sourceDigest).not.toBe(v1.sourceDigest);
  });
});

describe('FR-04 feed monitoring (scenario 18)', () => {
  it('emits once per digest; 304 is quiet; outage yields bounded error + freshness warning', async () => {
    let state: FeedState = { url: 'https://api.vendor/changelog', consecutiveFailures: 0, emittedDigests: new Set() };
    const noSleep = async (_ms: number) => {};
    const ok = await pollFeed(state, async () => ({ status: 200, body: 'v1-body', etag: 'e1' }), Date.now(), { sleep: noSleep });
    expect(ok.changed).toBe(true);
    state = ok.state;
    const dup = await pollFeed(state, async () => ({ status: 200, body: 'v1-body', etag: 'e1' }), Date.now(), { sleep: noSleep });
    expect(dup.changed).toBe(false); // no duplicated alerts
    const nm = await pollFeed(state, async () => ({ status: 304, body: '' }), Date.now(), { sleep: noSleep });
    expect(nm.notModified).toBe(true);
    const down = await pollFeed(state, async () => ({ status: 500, body: '' }), Date.now(), { sleep: noSleep, maxRetries: 2 });
    expect(down.error).toMatch(/bounded retry/);
    expect(freshnessStatus({ ...state, lastSuccessAt: Date.now() - 3600000 * 5 }, 60000).fresh).toBe(false);
  });
});
