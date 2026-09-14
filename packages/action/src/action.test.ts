import { describe, it, expect } from 'vitest';

describe('action entrypoint', () => {
  it('exports a run function', async () => {
    // The action module runs immediately on import; guard against GITHUB env absence.
    // We only verify the module can be loaded without crashing the test runner.
    const mod = await import('./index.js');
    expect(typeof mod.run).toBe('function');
  });
});
