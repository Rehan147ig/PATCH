import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ScanHit, ScanReport } from './types.js';

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
 */
export function planCodemods(reports: ScanReport[], rootDir: string): CodemodResult {
  const changedFiles = new Map<string, string>();
  const unfixed: ScanHit[] = [];
  let replacements = 0;

  for (const report of reports) {
    for (const hit of report.hits) {
      if (!hit.fix || !hit.replacement || hit.replacement === hit.snippet) {
        unfixed.push(hit);
        continue;
      }
      const filePath = path.join(rootDir, hit.file);
      let content = changedFiles.get(hit.file);
      if (content === undefined) {
        // Read from disk once per file.
        content = readFileOrEmpty(filePath);
        changedFiles.set(hit.file, content);
      }
      // The hit position is recorded in the original file; if this file was
      // already modified by a previous hit in the same file, positions shift.
      // For the MVP we only handle the simple case: single replacement per file.
      const idx = content.indexOf(hit.snippet);
      if (idx === -1) {
        unfixed.push(hit);
        continue;
      }
      const replacementText = hit.replacement;
      if (content.indexOf(replacementText, idx) !== -1 && content.slice(idx, idx + replacementText.length) === replacementText) {
        // Already applied or identical text; skip to avoid no-op.
        if (content.slice(idx, idx + hit.snippet.length) !== hit.snippet) {
          unfixed.push(hit);
          continue;
        }
      }
      content = content.slice(0, idx) + replacementText + content.slice(idx + hit.snippet.length);
      changedFiles.set(hit.file, content);
      replacements++;
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
