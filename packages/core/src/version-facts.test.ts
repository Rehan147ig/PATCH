import { describe, it, expect } from 'vitest';
import { collectVersionFacts, satisfiesRange, isExposedToVersion, upgradeApplies } from './version-facts.js';

describe('FR-03 VersionFacts', () => {
  it('prefers lockfile over range; flags conflicts visibly', () => {
    const f = collectVersionFacts({
      provider: 'stripe', sdkPackage: 'stripe',
      packageJson: { dependencies: { stripe: '^12.0.0' } },
      lockfile: { stripe: '11.5.0' },
    });
    expect(f.declaredRange).toBe('^12.0.0');
    expect(f.resolvedSdk).toBe('11.5.0');
    expect(f.confidence).toBe('conflicting');
    expect(f.conflicts.length).toBeGreaterThan(0);
  });

  it('never interprets deployment names as model versions (scenario 4)', () => {
    const f = collectVersionFacts({ provider: 'openai', deploymentName: 'my-gpt-deploy' });
    expect(f.modelId).toBeNull();
    expect(f.needsInformation.join(' ')).toMatch(/deployment name is not a model version/);
  });

  it('unknown webhook/account version yields needs-information, no guess', () => {
    const f = collectVersionFacts({ provider: 'stripe' });
    expect(f.confidence).toBe('external-unknown');
    expect(f.needsInformation.length).toBeGreaterThan(0);
  });
});

describe('FR-05 exposure vs upgrade (scenario 3)', () => {
  it('old major pinned: exposure excludes new major but targeted upgrade still matches source range', () => {
    expect(isExposedToVersion('11.5.0', '>=12.0.0')).toBe(false);
    expect(upgradeApplies('11.5.0', '>=11.0.0 <12.0.0')).toBe(true);
    expect(satisfiesRange('11.5.0', '>=11.0.0 <12.0.0' as unknown as string)).toBe(true);
  });
});
