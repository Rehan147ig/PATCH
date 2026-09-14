/**
 * FR-02: Discover integrations automatically — aliases, wrappers, workspace
 * imports. PRD §6: language-aware symbol resolution for imports, renamed
 * bindings, re-exports, local wrappers, workspace packages, SDK factories.
 * Scenario 2: same SDK imported under aliases/re-exported wrapper → correct
 * usages discovered; unrelated names excluded. Unknowns are retained, never
 * silently dropped.
 */

export interface AliasMap {
  /** local name -> canonical dotted path, e.g. 'myStripe' -> 'stripe' */
  bindings: Map<string, string>;
  /** wrapper function -> wrapped SDK path, e.g. 'listProducts' -> 'stripe.products.list' */
  wrappers: Map<string, string>;
  /** re-exported names: local -> original, e.g. 'Skus' -> 'stripe.skus' */
  reexports: Map<string, string>;
  /** workspace package -> real path (from package.json workspaces). */
  workspace: Map<string, string>;
  /** identifiers that look provider-ish but could not be resolved. */
  unknowns: string[];
}

/** Parse workspace package names from root package.json workspaces globs (best-effort). */
export function parseWorkspaceAliases(rootPackageJson: unknown): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const pkg = rootPackageJson as { workspaces?: string[] | { packages?: string[] }; name?: string };
    const globs: string[] = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
    for (const g of globs) out.set(g, g);
  } catch { /* ignore */ }
  return out;
}

/**
 * Build an alias map from a set of source files (path -> content).
 * Handles: default/named/namespace imports with aliases, require() aliases,
 * `const x = stripe.charges` member aliases, re-exports, and thin wrappers
 * `function f(){ return stripe.X.y(...) }` / arrow wrappers.
 */
export function buildAliasMap(sources: Map<string, string>, knownRoots: string[] = ['stripe', 'openai']): AliasMap {
  const bindings = new Map<string, string>();
  const wrappers = new Map<string, string>();
  const reexports = new Map<string, string>();
  const workspace = new Map<string, string>();
  const unknowns: string[] = [];

  for (const [, content] of sources) {
    // import Stripe from 'stripe' / import { X as Y } from 'openai' / import * as ns
    for (const m of content.matchAll(/import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\}[\s\S]*?)?(?:\*\s*as\s+(\w+)\s+)?from\s+['"]([^'"]+)['"]/g)) {
      const [, def, named, ns, mod] = m;
      const root = knownRoots.find((r) => mod === r || mod.startsWith(r + '/')) ?? null;
      if (def && root) bindings.set(def, root);
      if (ns && root) bindings.set(ns, root);
      if (named) {
        for (const part of named.split(',')) {
          const seg = part.trim().split(/\s+as\s+/);
          const orig = seg[0]?.trim();
          const local = (seg[1] ?? orig)?.trim();
          if (!orig || !local) continue;
          if (root) bindings.set(local, `${root}.${orig}`);
          else if (/stripe|openai|anthropic|gemini/i.test(mod)) unknowns.push(`${local} (from ${mod})`);
        }
      }
      if (!root && /stripe|openai|anthropic|gemini/i.test(mod)) unknowns.push(`import from ${mod}`);
    }
    // const x = require('stripe') / const { a } = require('openai')
    for (const m of content.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const [, local, mod] = m;
      const root = knownRoots.find((r) => mod === r);
      if (root) bindings.set(local, root);
      else if (/stripe|openai/i.test(mod)) unknowns.push(`${local} (require ${mod})`);
    }
    // const alias = stripe.charges / const { list } = stripe.products
    for (const m of content.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*((?:stripe|openai|anthropic)(?:\.\w+)+)/g)) {
      bindings.set(m[1], m[2]);
    }
    // re-exports: export { X } from './y' / export { Sku as Skus }
    for (const m of content.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      for (const part of m[1].split(',')) {
        const seg = part.trim().split(/\s+as\s+/);
        const orig = seg[0]?.trim();
        const local = (seg[1] ?? orig)?.trim();
        if (orig && local) reexports.set(local, orig);
      }
    }
    // wrappers: function name(...) { return stripe.a.b(...) } / const name = (...) => stripe.a.b(
    for (const m of content.matchAll(/(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)\s*[^;]*?return\s+((?:stripe|openai|anthropic)(?:\.\w+)+)/g)) {
      wrappers.set(m[1] ?? m[2], m[3]);
    }
    for (const m of content.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*((?:stripe|openai|anthropic)(?:\.\w+)+)/g)) {
      wrappers.set(m[1], m[2]);
    }
  }
  return { bindings, wrappers, reexports, workspace, unknowns: [...new Set(unknowns)] };
}

/**
 * Resolve a dotted usage through aliases/wrappers to its canonical SDK path.
 * Returns null when it cannot be resolved (caller retains it as unknown).
 */
export function resolveCanonical(name: string, aliases: AliasMap): string | null {
  if (!name) return null;
  const [head, ...rest] = name.split('.');
  if (aliases.bindings.has(head)) {
    return [aliases.bindings.get(head)!, ...rest].join('.');
  }
  if (aliases.wrappers.has(head) && rest.length === 0) {
    return aliases.wrappers.get(head)!;
  }
  if (aliases.reexports.has(head)) {
    return [aliases.reexports.get(head)!, ...rest].join('.');
  }
  if (/^(stripe|openai|anthropic|gemini)(\.|$)/.test(name)) return name;
  return null;
}

/** True when a candidate name belongs to the target SDK after alias resolution. */
export function belongsToSdk(name: string, sdkRoot: string, aliases: AliasMap): boolean {
  const canonical = resolveCanonical(name, aliases);
  if (!canonical) return false;
  return canonical === sdkRoot || canonical.startsWith(sdkRoot + '.');
}
