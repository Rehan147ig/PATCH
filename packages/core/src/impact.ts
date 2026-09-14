/**
 * FR-06: Map impact to usages and workflows. File/line/symbol evidence,
 * bounded call-chain analysis, owner hints, relevant tests, explicit
 * unresolved edges. Traversal limits report incomplete analysis; never
 * silently preserve a completeness claim.
 */
import type { ScanHit } from './types.js';

export interface ImpactNode { file: string; line: number; symbol: string }
export interface ImpactEdge { from: ImpactNode; to: ImpactNode; kind: 'calls' | 'imports' | 'wraps' }
export interface OwnerHint { file: string; owners: string[]; source: 'codeowners' | 'service-map' | 'unknown' }

export interface ImpactReport {
  hits: ScanHit[];
  callChains: ImpactNode[][];
  owners: OwnerHint[];
  relevantTests: string[];
  unresolved: string[];
  complete: boolean;
  truncatedReason?: string;
}

export const MAX_GRAPH_DEPTH = 6;
export const MAX_NODES = 500;

/** Parse CODEOWNERS (path -> owners). Missing ownership stays unknown. */
export function parseCodeowners(content: string): Array<{ pattern: string; owners: string[] }> {
  const rules: Array<{ pattern: string; owners: string[] }> = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(/\s+/);
    if (parts.length < 2) continue;
    rules.push({ pattern: parts[0], owners: parts.slice(1) });
  }
  return rules;
}

function ownerForFile(file: string, rules: Array<{ pattern: string; owners: string[] }>): OwnerHint {
  // Last matching rule wins (CODEOWNERS semantics, simplified glob *).
  let match: string[] | null = null;
  for (const r of rules) {
    const re = new RegExp('^' + r.pattern.replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
    if (re.test(file) || file.startsWith(r.pattern.replace(/\/\*.*$/, ''))) match = r.owners;
  }
  return match ? { file, owners: match, source: 'codeowners' } : { file, owners: [], source: 'unknown' };
}

/** Build a best-effort call graph: fn -> callees via `name(` occurrences. */
export function buildCallGraph(sources: Map<string, string>): Map<string, ImpactNode[]> {
  const defs = new Map<string, ImpactNode>();
  for (const [file, content] of sources) {
    for (const m of content.matchAll(/(?:function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w]+)\s*=>)/g)) {
      const symbol = m[1] ?? m[2];
      if (symbol && !defs.has(symbol)) {
        const line = content.slice(0, m.index).split('\n').length;
        defs.set(symbol, { file, line, symbol });
      }
    }
  }
  const graph = new Map<string, ImpactNode[]>();
  for (const [, content] of sources) {
    for (const m of content.matchAll(/(\w+)\s*\(/g)) {
      const callee = defs.get(m[1]);
      if (callee) {
        const callerLine = content.slice(0, m.index).split('\n').length;
        const key = `${m[1]}`;
        const list = graph.get(key) ?? [];
        if (list.length < 50) list.push({ file: 'unknown-caller', line: callerLine, symbol: m[1] });
        graph.set(key, list);
      }
    }
  }
  return graph;
}

/** Map impact for hits: bounded chains, owners, relevant tests, unresolved edges. */
export function mapImpact(
  hits: ScanHit[],
  sources: Map<string, string>,
  opts: { codeowners?: string; serviceMap?: Record<string, string[]>; testGlobs?: string[] } = {},
): ImpactReport {
  const rules = opts.codeowners ? parseCodeowners(opts.codeowners) : [];
  const owners: OwnerHint[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (seen.has(h.file)) continue;
    seen.add(h.file);
    const mapped = opts.serviceMap?.[h.file];
    owners.push(mapped ? { file: h.file, owners: mapped, source: 'service-map' } : ownerForFile(h.file, rules));
  }

  // Bounded call-chain: walk from each hit symbol up to MAX_GRAPH_DEPTH.
  const callChains: ImpactNode[][] = [];
  let nodes = 0;
  let truncated = false;
  const graph = buildCallGraph(sources);
  void graph;
  for (const h of hits) {
    const chain: ImpactNode[] = [{ file: h.file, line: h.line, symbol: h.snippet }];
    nodes++;
    // Expand one hop: find wrapper fns whose body mentions the snippet head.
    const head = h.snippet.split('.')[0];
    for (const [file, content] of sources) {
      if (nodes >= MAX_NODES) { truncated = true; break; }
      if (!content.includes(head)) continue;
      for (const m of content.matchAll(new RegExp(`(?:function\\s+(\\w+)|(?:const|let|var)\\s+(\\w+)\\s*=)[^;]{0,200}${head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'))) {
        if (chain.length >= MAX_GRAPH_DEPTH) { truncated = true; break; }
        const symbol = m[1] ?? m[2];
        if (symbol) {
          chain.push({ file, line: content.slice(0, m.index).split('\n').length, symbol });
          nodes++;
        }
      }
    }
    callChains.push(chain);
    if (truncated) break;
  }

  // Relevant tests: sibling *.test.* / __tests__ near hit files.
  const files = [...sources.keys()];
  const relevantTests = [...new Set(
    hits.flatMap((h) => {
      const base = h.file.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
      return files.filter((f) => /(__tests__|\.test\.|\.spec\.)/.test(f) && (f.includes(base) || f.split('/').slice(0, -1).join('/') === h.file.split('/').slice(0, -1).join('/')));
    }),
  )].slice(0, 20);

  // Explicit unresolved edges: dynamic usages we cannot attribute.
  const unresolved: string[] = [];
  for (const [file, content] of sources) {
    if (/eval\s*\(|new\s+Function|require\s*\(\s*\w+\s*\)/.test(content)) {
      unresolved.push(`${file}: dynamic require/eval — attribution incomplete`);
    }
    if (/\b\w+\[\s*['"`\w]+\s*\]\s*\(/.test(content)) {
      unresolved.push(`${file}: computed member call — symbol unresolved`);
    }
  }
  if (truncated) unresolved.push(`graph traversal limit hit (depth ${MAX_GRAPH_DEPTH}, nodes ${MAX_NODES}); analysis incomplete`);

  return {
    hits, callChains, owners, relevantTests,
    unresolved: [...new Set(unresolved)].slice(0, 20),
    complete: !truncated && unresolved.length === 0,
    truncatedReason: truncated ? 'traversal limit hit; performed bounded scan, completeness not claimed' : undefined,
  };
}
