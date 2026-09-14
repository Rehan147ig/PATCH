import { describe, it, expect } from 'vitest';
import { buildAliasMap, resolveCanonical, belongsToSdk } from './alias-resolution.js';

const SOURCES = new Map([
  ['a.ts', `import Stripe from 'stripe';\nimport { listSkus as listProducts } from './shop';\nconst s = new Stripe('k');\ns.skus.list({});`],
  ['b.ts', `import * as myStripe from 'stripe';\nmyStripe.products.list({});`],
  ['c.ts', `const stripe = require('stripe')('k');\nconst charges = stripe.charges;\ncharges.create({});`],
  ['d.ts', `import { openai } from './client';\nfunction listProducts() { return openai.models.list(); }\nlistProducts();`],
  ['e.ts', `const unrelated = { list() {} };\nunrelated.list();`],
]);

describe('FR-02 aliases, wrappers, re-exports (scenario 2)', () => {
  it('resolves aliased SDK roots to canonical paths', () => {
    const aliases = buildAliasMap(SOURCES);
    expect(aliases.bindings.get('myStripe')).toBe('stripe');
    expect(resolveCanonical('myStripe.products.list', aliases)).toBe('stripe.products.list');
    expect(resolveCanonical('charges.create', aliases)).toBe('stripe.charges.create');
  });

  it('includes wrapper calls, excludes unrelated names', () => {
    const aliases = buildAliasMap(SOURCES);
    expect(belongsToSdk('myStripe.products.list', 'stripe', aliases)).toBe(true);
    expect(belongsToSdk('unrelated.list', 'stripe', aliases)).toBe(false);
  });

  it('retains unknowns instead of dropping them', () => {
    const src = new Map([['x.ts', `import { Foo } from 'stripe-fake-addon';\nFoo.bar();`]]);
    const aliases = buildAliasMap(src);
    expect(aliases.unknowns.length).toBeGreaterThanOrEqual(0);
    expect(resolveCanonical('Foo.bar', aliases)).toBeNull();
  });
});
