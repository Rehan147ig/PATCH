import { describe, it, expect } from 'vitest';
import { mapImpact, parseCodeowners } from './impact.js';
import type { ScanHit } from './types.js';

const hit = (file: string, line: number, snippet: string): ScanHit => ({
  manifestId: 'm', changeIndex: 0, kind: 'renamed-call', file, line, column: 1, snippet, confidence: 0.9,
});

describe('FR-06 impact mapping', () => {
  it('maps owners, chains, relevant tests, and unresolved edges', () => {
    const sources = new Map([
      ['src/pay.ts', `import { stripe } from './client';\nfunction chargeAll(){ return stripe.charges.create({}); }`],
      ['src/pay.test.ts', `import { chargeAll } from './pay';\ntest('x', () => {});`],
      ['src/dyn.ts', `const m = require(name);\nfoo[bar]();`],
    ]);
    const report = mapImpact(
      [hit('src/pay.ts', 2, 'stripe.charges.create')],
      sources,
      { codeowners: 'src/pay.ts @payments-team\n' },
    );
    expect(report.owners[0].owners).toEqual(['@payments-team']);
    expect(report.callChains[0].length).toBeGreaterThanOrEqual(1);
    expect(report.relevantTests).toContain('src/pay.test.ts');
    expect(report.unresolved.join('\n')).toMatch(/dynamic|computed/);
    expect(report.complete).toBe(false);
  });

  it('missing ownership stays unknown (never auto-approver)', () => {
    expect(parseCodeowners('# empty\n')).toEqual([]);
    const r = mapImpact([hit('src/x.ts', 1, 'stripe.x')], new Map([['src/x.ts', 'stripe.x']]));
    expect(r.owners[0].source).toBe('unknown');
  });
});
