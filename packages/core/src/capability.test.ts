import { describe, it, expect } from 'vitest';
import { capabilityKey, meetsLaunchThreshold } from './capability.js';

describe('capability key (§10)', () => {
  it('builds a canonical key and enforces evaluation minimums', () => {
    const k = capabilityKey({
      provider: 'openai', language: 'typescript', changeFamily: 'model-retirement',
      extractor: 'scanner-v2', transform: 'codemod-v1', validationProfile: 'default-v1',
    });
    expect(k.split('|')).toHaveLength(10);
    expect(meetsLaunchThreshold({ positives: 30, negatives: 30, ambiguous: 20, repos: 5 })).toBe(true);
    expect(meetsLaunchThreshold({ positives: 5, negatives: 30, ambiguous: 20, repos: 5 })).toBe(false);
  });
});
