import { promises as fs } from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';

import type {
  ManifestChange,
  ManifestFix,
  ManifestMatch,
  MigrationManifest,
  ScanHit,
  ScanReport,
} from './types.js';
import { annotateReport } from './risk.js';

/** Languages the scanner supports. */
export type SupportedLang = 'typescript' | 'javascript' | 'json';

const LANG_EXTENSIONS: Record<SupportedLang, string[]> = {
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  json: ['.json'],
};

function languageForExtension(ext: string): SupportedLang | null {
  for (const [lang, exts] of Object.entries(LANG_EXTENSIONS)) {
    if (exts.includes(ext)) return lang as SupportedLang;
  }
  return null;
}

/** A single lexical token with position info. */
interface Token {
  /** Raw text of the token (identifier, string content, punctuation, number, comment). */
  text: string;
  /** 0-based start index in the source. */
  start: number;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  kind: 'identifier' | 'string' | 'number' | 'punct' | 'comment';
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * Tokenize JavaScript/TypeScript/JSON source.
 * Strips comments and string contents (keeps the quote positions but not the
 * inner text), so we can match identifiers reliably without parsing strings.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = source.length;

  const advance = (count: number) => {
    for (let k = 0; k < count; k++) {
      if (source[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  while (i < n) {
    const ch = source[i];
    const start = i;

    // Whitespace
    if (/\s/.test(ch)) {
      advance(1);
      continue;
    }

    // Comments
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') advance(1);
      tokens.push({ text: source.slice(start, i), start, line, column: col, kind: 'comment' });
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      advance(2);
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) advance(1);
      if (i < n) advance(2);
      tokens.push({ text: source.slice(start, i), start, line, column: col, kind: 'comment' });
      continue;
    }

    // Strings (keep the delimiter, skip content)
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      advance(1);
      while (i < n) {
        if (source[i] === '\\') {
          advance(2);
          continue;
        }
        if (source[i] === quote) {
          advance(1);
          break;
        }
        advance(1);
      }
      tokens.push({ text: source.slice(start, i), start, line, column: col, kind: 'string' });
      continue;
    }

    // Identifiers
    if (IDENT_START.test(ch)) {
      while (i < n && IDENT_CHAR.test(source[i])) advance(1);
      tokens.push({ text: source.slice(start, i), start, line, column: col, kind: 'identifier' });
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      while (i < n && /[0-9a-zA-Z_.]/.test(source[i])) advance(1);
      tokens.push({ text: source.slice(start, i), start, line, column: col, kind: 'number' });
      continue;
    }

    // Punctuation / operators
    {
      advance(1);
      tokens.push({ text: source.slice(start, i), start, line, column: col, kind: 'punct' });
      continue;
    }
  }

  return tokens;
}

/** A matched candidate found in source. */
interface Candidate {
  kind: 'call' | 'field' | 'parameter' | 'sdk';
  /** Dotted path for calls, e.g. 'stripe.charges.create'. */
  name: string;
  /** For parameter matches, the argument object text. */
  argsText?: string;
  /** For sdk matches, the imported package name. */
  packageName?: string;
  /** For sdk matches, the installed package version (from package.json). */
  packageVersion?: string;
  /** End of the enclosing statement/expression line range. */
  lineEnd?: number;
  line: number;
  column: number;
  start: number;
  end: number;
}

/**
 * Extract candidates from token stream:
 * - calls: identifier(.identifier)* followed by '('
 * - fields: identifier(.identifier)* (member access) and object literal keys
 * - parameters: argument object keys inside call parens
 * - sdk: import declarations
 */
function extractCandidates(tokens: Token[]): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'identifier') continue;

    // Import: `import ... from 'pkg'` or `import 'pkg'`
    if (t.text === 'import') {
      let j = i + 1;
      while (j < tokens.length && tokens[j].kind !== 'string') j++;
      if (j < tokens.length && tokens[j].kind === 'string') {
        const pkg = tokens[j].text.replace(/['"`]/g, '');
        out.push({
          kind: 'sdk',
          name: pkg,
          packageName: pkg,
          line: tokens[j].line,
          column: tokens[j].column,
          start: tokens[j].start,
          end: tokens[j].start + tokens[j].text.length,
        });
      }
      continue;
    }

    // require('pkg')
    if (t.text === 'require' && tokens[i + 1]?.text === '(') {
      let j = i + 2;
      while (j < tokens.length && tokens[j].kind !== 'string' && tokens[j].text !== ')') j++;
      if (j < tokens.length && tokens[j].kind === 'string') {
        const pkg = tokens[j].text.replace(/['"`]/g, '');
        out.push({
          kind: 'sdk',
          name: pkg,
          packageName: pkg,
          line: tokens[j].line,
          column: tokens[j].column,
          start: tokens[j].start,
          end: tokens[j].start + tokens[j].text.length,
        });
      }
      continue;
    }

    // Dotted path: collect identifier(.identifier)*
    let j = i;
    const parts = [t.text];
    let isCall = false;
    while (j + 2 < tokens.length && tokens[j + 1].text === '.' && tokens[j + 2].kind === 'identifier') {
      parts.push(tokens[j + 2].text);
      j += 2;
    }
    const dotted = parts.join('.');
    if (tokens[j + 1]?.text === '(') {
      isCall = true;
    }
    if (parts.length > 1 || isCall) {
      // Compute the enclosing statement line range (to the next ';' or matching close).
      let lineEnd = t.line;
      for (let k = j + 1; k < tokens.length && tokens[k].line <= lineEnd + 6; k++) {
        if (tokens[k].text === ';' || tokens[k].text === '}') {
          lineEnd = tokens[k].line;
          break;
        }
        if (tokens[k].text === '(') {
          // find matching close paren across lines
          let depth = 0;
          for (let m = k; m < tokens.length; m++) {
            if (tokens[m].text === '(') depth++;
            else if (tokens[m].text === ')') {
              depth--;
              if (depth === 0) {
                lineEnd = tokens[m].line;
                break;
              }
            }
          }
          break;
        }
        lineEnd = Math.max(lineEnd, tokens[k].line);
      }
      out.push({
        kind: isCall ? 'call' : 'field',
        name: dotted,
        line: t.line,
        column: t.column,
        start: t.start,
        end: tokens[j].start + tokens[j].text.length,
        lineEnd,
      });
    }

    // Object literal keys: `key:` inside braces, or `key =` in object
    // Detect pattern: identifier followed by ':' (not '::', not ternary)
    if (tokens[i + 1]?.text === ':' && tokens[i + 2]?.text !== ':') {
      out.push({
        kind: 'field',
        name: t.text,
        line: t.line,
        column: t.column,
        start: t.start,
        end: t.start + t.text.length,
      });
    }

    // Parameter: identifier followed by ':' within an object literal
    // (preceded by '{' or ','), i.e. an argument key in a call.
    if (
      tokens[i + 1]?.text === ':' &&
      (tokens[i - 1]?.text === '{' || tokens[i - 1]?.text === ',')
    ) {
      out.push({
        kind: 'parameter',
        name: t.text,
        line: t.line,
        column: t.column,
        start: t.start,
        end: t.start + t.text.length,
      });
    }
  }

  // String-literal candidates: URL paths (for endpoint matching) and
  // header names (for telemetry matching).
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'string') continue;
    const text = t.text.replace(/['"`]/g, '');
    if (text.startsWith('/') || text.startsWith('https://') || text.startsWith('http://')) {
      out.push({
        kind: 'field',
        name: text,
        line: t.line,
        column: t.column,
        start: t.start,
        end: t.start + t.text.length,
        argsText: 'url',
      });
    }
    // Header-like strings: 'Sunset', 'Deprecation', 'X-...'
    if (/^(Sunset|Deprecation|X-|Stripe-Version|OpenAI-Version)/i.test(text)) {
      out.push({
        kind: 'field',
        name: text,
        line: t.line,
        column: t.column,
        start: t.start,
        end: t.start + t.text.length,
        argsText: 'header',
      });
    }
  }
  return out;
}

/** Simple semver compare. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/[^0-9.]/g, '').split('.').map(Number);
  const pb = b.replace(/[^0-9.]/g, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

function matchesPatternKind(m: ManifestMatch, c: Candidate): boolean {
  if (c.kind === 'call') {
    if (!m.call) return false;
    const expected = m.call.object ? `${m.call.object}.${m.call.name}` : m.call.name;
    if (c.name !== expected && !c.name.startsWith(expected + '.')) return false;
    return true;
  }
  if (c.kind === 'field') {
    // Telemetry/header match: the candidate is a header-like string literal.
    if (m.telemetry) {
      if (c.argsText === 'header' && c.name === m.telemetry.header) {
        if (m.telemetry.value && !c.name.includes(m.telemetry.value)) return false;
        return true;
      }
      return false;
    }
    // Endpoint match: the candidate is a URL/path string literal.
    if (m.endpoint) {
      if (c.argsText === 'url') {
        const path = m.endpoint.path;
        if (c.name === path || c.name.endsWith(path)) return true;
      }
      return false;
    }
    if (!m.field) return false;
    if (m.field.object) {
      // Require the full dotted name to start with object.name (exact context).
      const expected = `${m.field.object}.${m.field.name}`;
      if (c.name !== expected && !c.name.startsWith(expected + '.')) return false;
    } else {
      // Bare field name match.
      if (m.field.name && c.name !== m.field.name) return false;
    }
    return true;
  }
  if (c.kind === 'parameter') {
    if (!m.parameter) return false;
    if (m.parameter.name && c.name !== m.parameter.name) return false;
    return true;
  }
  if (c.kind === 'sdk') {
    if (!m.sdk) return false;
    if (m.sdk.package && c.packageName !== m.sdk.package) return false;
    if (m.sdk.minVersion && c.packageVersion) {
      if (compareVersions(c.packageVersion, m.sdk.minVersion) >= 0) return false;
    }
    return true;
  }
  return false;
}

/**
 * Check whether a manifest's match patterns are satisfied by the candidate set
 * of a single file. Returns every candidate that satisfies the (possibly
 * compound) match. If the match has exactly one pattern kind, every matching
 * candidate is returned. If it has multiple kinds (e.g. call + parameter),
 * all must appear among the candidates — the call/field candidates are the
 * "primary" matches that get reported.
 */
function matchesCompound(m: ManifestMatch, candidates: Candidate[]): Candidate[] {
  const kinds: Array<'call' | 'field' | 'parameter' | 'sdk'> = [];
  if (m.call) kinds.push('call');
  if (m.field || m.telemetry || m.endpoint) kinds.push('field');
  if (m.parameter) kinds.push('parameter');
  if (m.sdk) kinds.push('sdk');

  // Compound: every kind must have at least one matching candidate.
  for (const kind of kinds) {
    if (!candidates.some((c) => c.kind === kind && matchesPatternKind(m, c))) {
      return [];
    }
  }

  // Return the "primary" candidates (call/field), all of them.
  const primaryKinds: Array<'call' | 'field'> = kinds.filter(
    (k): k is 'call' | 'field' => k === 'call' || k === 'field',
  );
  if (primaryKinds.length === 0) {
    // Only parameter/sdk — report the first matching candidate once.
    const any = candidates.find((c) => matchesPatternKind(m, c));
    return any ? [any] : [];
  }
  return candidates.filter((c) => (primaryKinds as string[]).includes(c.kind) && matchesPatternKind(m, c));
}

/**
 * Compute the replacement text for a fix, if it is mechanical.
 * Returns undefined for report-only fixes (convert-amount, replace) that
 * require human judgment or context beyond a simple rename.
 */
function computeReplacement(fix: ManifestFix, match: Candidate): string | undefined {
  if (!fix || !fix.from || !fix.to) return undefined;
  if (fix.kind === 'rename-call' || fix.kind === 'rename-field' || fix.kind === 'rename-parameter') {
    // Replace the matched prefix within the full name.
    // E.g. from 'stripe.skus' to 'stripe.products' applied to 'stripe.skus.list' -> 'stripe.products.list'.
    if (match.name === fix.from) {
      return fix.to;
    }
    if (match.name.startsWith(fix.from + '.')) {
      return fix.to + match.name.slice(fix.from.length);
    }
  }
  return undefined;
}

function applyFix(fix: ManifestFix, match: Candidate, change: ManifestChange): ScanHit {
  const replacement = computeReplacement(fix, match);
  return {
    manifestId: change.description.slice(0, 80),
    changeIndex: 0,
    kind: change.type,
    file: '',
    line: match.line,
    column: match.column,
    snippet: match.name,
    confidence: 0.95,
    fix,
    replacement,
  };
}

/**
 * Scan a directory tree for code matching the given manifests.
 * Returns one ScanReport per manifest that produced at least one hit.
 */
export async function scanDirectory(
  rootDir: string,
  manifests: MigrationManifest[],
  options: { ignore?: string[]; services?: string[] } = {},
): Promise<ScanReport[]> {
  const reports: ScanReport[] = [];
  const startTime = Date.now();

  const files: string[] = [];
  for (const exts of Object.values(LANG_EXTENSIONS)) {
    for (const ext of exts) {
      const found = await glob(`**/*${ext}`, {
        cwd: rootDir,
        ignore: options.ignore ?? ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/build/**'],
        nodir: true,
      });
      files.push(...found);
    }
  }

  // Resolve installed package versions once (for sdk minVersion matching).
  const pkgVersions = new Map<string, string>();
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      pkgVersions.set(name, range.replace(/[^0-9.]/g, ''));
    }
  } catch {
    // No package.json — sdk version gating is skipped.
  }

  for (const manifest of manifests) {
    const hits: ScanHit[] = [];
    let filesScanned = 0;
    for (const file of files) {
      const lang = languageForExtension(path.extname(file));
      if (!lang) continue;
      if (manifest.lang && lang !== manifest.lang) continue;
      try {
        const source = await fs.readFile(path.join(rootDir, file), 'utf8');
        filesScanned++;
        const tokens = tokenize(source);
        const candidates = extractCandidates(tokens);
        for (const cand of candidates) {
          if (cand.kind === 'sdk' && cand.packageName && pkgVersions.has(cand.packageName)) {
            cand.packageVersion = pkgVersions.get(cand.packageName);
          }
        }
        for (let ci = 0; ci < manifest.changes.length; ci++) {
          const change = manifest.changes[ci];
          if (!change.match) continue;
          const matched = matchesCompound(change.match, candidates);
          for (const cand of matched) {
            const hit = change.fix ? applyFix(change.fix, cand, change) : null;
            if (hit) {
              hit.file = file;
              hits.push(hit);
            } else {
              // Report-only match: no mechanical fix, but still an affected usage.
              hits.push({
                manifestId: manifest.id,
                changeIndex: ci,
                kind: change.type,
                file,
                line: cand.line,
                column: cand.column,
                snippet: cand.name,
                confidence: 0.95,
              });
            }
            if (cand.lineEnd && cand.lineEnd > cand.line) {
              const last = hits[hits.length - 1];
              last.lineRange = { start: cand.line, end: cand.lineEnd };
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
    if (hits.length > 0) {
      const report: ScanReport = {
        manifest,
        hits,
        filesScanned,
        durationMs: Date.now() - startTime,
      };
      annotateReport(report, options.services);
      reports.push(report);
    }
  }

  return reports;
}
