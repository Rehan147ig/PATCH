import { describe, it, expect } from 'vitest';
import { setAiProvider, runAiCodemod, noProvider, type AiCodemodProvider } from '../src/ai-codemod.js';
import type { ScanHit } from '../src/types.js';

describe('ai codemod', () => {
  it('returns report-only when no provider is configured', async () => {
    setAiProvider(noProvider);
    const hits: ScanHit[] = [{ manifestId: 'm', changeIndex: 0, kind: 'renamed-call', file: 'a.ts', line: 1, column: 1, snippet: 'x', confidence: 0.9 }];
    const result = await runAiCodemod(
      { changeIndex: 0, prompt: 'migrate', expectedOutcome: 'async' },
      hits,
      new Map([['a.ts', 'const x = 1;']]),
    );
    expect(result.applied).toBe(false);
    expect(result.error).toContain('No AI provider');
  });

  it('validates AI output and rejects invalid line ranges', async () => {
    const mock: AiCodemodProvider = {
      id: 'mock',
      async complete() {
        return JSON.stringify({
          replacements: [
            { file: 'a.ts', startLine: 1, endLine: 1, newText: 'const y = 2;', explanation: 'test' },
            { file: 'a.ts', startLine: 99, endLine: 100, newText: 'bad', explanation: 'out of range' },
            { file: 'missing.ts', startLine: 1, endLine: 1, newText: 'nope', explanation: 'no such file' },
          ],
        });
      },
    };
    setAiProvider(mock);
    const result = await runAiCodemod(
      { changeIndex: 0, prompt: 'migrate', expectedOutcome: 'x' },
      [],
      new Map([['a.ts', 'line1\nline2\nline3']]),
    );
    expect(result.applied).toBe(true);
    expect(result.replacements).toHaveLength(1);
    expect(result.replacements[0].file).toBe('a.ts');
    expect(result.replacements[0].newText).toBe('const y = 2;');
  });

  it('rejects malformed JSON from the provider', async () => {
    const mock: AiCodemodProvider = {
      id: 'mock',
      async complete() {
        return 'not json at all';
      },
    };
    setAiProvider(mock);
    const result = await runAiCodemod(
      { changeIndex: 0, prompt: 'migrate', expectedOutcome: 'x' },
      [],
      new Map(),
    );
    expect(result.applied).toBe(false);
    expect(result.error).toContain('no valid replacements');
  });
});
