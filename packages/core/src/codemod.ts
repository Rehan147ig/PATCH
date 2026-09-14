import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ScanHit, ScanReport } from './types.js';
import { isOffsetInCode } from './scanner.js';

export interface CodemodResult {
  /** Files changed, relative path -> new content. */
  changedFiles: Map<string, string>;
  /** Hits that could not be fixed. */
  unfixed: ScanHit[];
  /** Number of individual replacements applied. */
  replacements: number;
}

/**
 * Apply fixes from scan reports to the working tree.
 * Returns the set of changed files and their new content without writing to disk.
 *
 * FR-07 source-scoped edits:
 * - Every applied edit is bound to the hit's exact `offset`/`endOffset`
 *   recorded by the scanner. `content.slice(offset, endOffset)` must equal
 *   `hit.snippet`, otherwise the hit is rejected as unfixed (stale content,
 *   unrelated symbol, or shifted positions).
 * - The offset must resolve to real code (not a comment/string) via
 *   re-tokenization of the current file content.
 * - The fix's `from` prefix must match the snippet; cross-kind application
 *   is rejected.
 * - Text search (`indexOf`) is never used: changes in comments or unrelated
 *   symbols with the same text are rejected by construction.
 * - Edits within one file are applied descending by offset so earlier
 *   offsets stay valid; overlapping hits are applied once.
 */
export function planCodemods(reports: ScanReport[], rootDir: string): CodemodResult {
  const changedFiles = new Map<string, string>();
  const originalContent = new Map<string, string>();
  const unfixed: ScanHit[] = [];
  let replacements = 0;

  // Collect fixable hits per file.
  const byFile = new Map<string, ScanHit[]>();
  for (const report of reports) {
    for (const hit of report.hits) {
      if (!hit.fix || !hit.replacement || hit.replacement === hit.snippet) {
        unfixed.push(hit);
        continue;
      }
      if (hit.offset === undefined || hit.endOffset === undefined) {
        // No exact location — report-only. Never fall back to text search.
        unfixed.push(hit);
        continue;
      }
      const list = byFile.get(hit.file) ?? [];
      list.push(hit);
      byFile.set(hit.file, list);
    }
  }

  for (const [rel, hits] of byFile) {
    const filePath = path.join(rootDir, rel);
    let content = readFileOrEmpty(filePath);
    originalContent.set(rel, content);

    // Descending by offset keeps earlier offsets valid as we splice.
    const sorted = [...hits].sort((a, b) => (b.offset ?? 0) - (a.offset ?? 0));
    const appliedRanges: Array<{ start: number; end: number }> = [];
    let fileChanged = false;

    for (const hit of sorted) {
      const start = hit.offset!;
      const end = hit.endOffset!;
      // Bounds check.
      if (start < 0 || end <= start || end > content.length) {
        unfixed.push(hit);
        continue;
      }
      // Overlap check (already-applied range covers this hit).
      if (appliedRanges.some((r) => start < r.end && end > r.start)) {
        unfixed.push(hit);
        continue;
      }
      // Exact-symbol check against the current content.
      if (content.slice(start, end) !== hit.snippet) {
        unfixed.push(hit);
        continue;
      }
      // Comment/string rejection via re-tokenization.
      if (!isOffsetInCode(content, start)) {
        unfixed.push(hit);
        continue;
      }
      // Fix-to-symbol binding check.
      if (hit.fix?.from) {
        const from = hit.fix.from;
        if (hit.snippet !== from && !hit.snippet.startsWith(from + '.')) {
          unfixed.push(hit);
          continue;
        }
      }
      const replacementText = hit.replacement!;
      content = content.slice(0, start) + replacementText + content.slice(end);
      appliedRanges.push({ start, end: start + replacementText.length });
      fileChanged = true;
      replacements++;
    }

    if (fileChanged) {
      changedFiles.set(rel, content);
    }
  }

  return { changedFiles, unfixed, replacements };
}

function readFileOrEmpty(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Write planned changes to disk. Returns the list of written file paths.
 */
export async function writeCodemods(result: CodemodResult, rootDir: string): Promise<string[]> {
  const written: string[] = [];
  for (const [rel, content] of result.changedFiles) {
    const target = path.join(rootDir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    written.push(rel);
  }
  return written;
}

/**
 * After writing codemods, run a compile/type-check to verify nothing broke.
 * Returns a list of failing files, or [] if the build passes.
 */
export async function verifyBuild(rootDir: string, command = 'npx tsc --noEmit'): Promise<string[]> {
  try {
    const { execSync } = await import('node:child_process');
    execSync(command, { cwd: rootDir, stdio: 'pipe', timeout: 120000 });
    return [];
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr?.toString?.() ?? String(err);
    // Extract filenames from tsc output (rough heuristic).
    const files = new Set<string>();
    for (const line of stderr.split('\n')) {
      const m = line.match(/^(?:.*?\:\s*)?([^:]+\.tsx?|[^:]+\.jsx?|[^:]+\.mjs|[^:]+\.cjs):/);
      if (m) files.add(m[1]);
    }
    return [...files];
  }
}
