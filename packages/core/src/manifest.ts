import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MigrationManifest } from './types.js';

/**
 * Load a single manifest JSON file, validating the schema version.
 */
export async function loadManifest(filePath: string): Promise<MigrationManifest> {
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw) as MigrationManifest;
  if (parsed.schemaVersion !== '1.0') {
    throw new Error(`Unsupported manifest schema version: ${parsed.schemaVersion}`);
  }
  return parsed;
}

/**
 * Load all manifest JSON files from a directory (recursive, so vendor
 * subdirectories like manifests/stripe/*.json are picked up).
 */
export async function loadManifests(dir: string): Promise<MigrationManifest[]> {
  const manifests: MigrationManifest[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          manifests.push(await loadManifest(full));
        } catch {
          // Skip invalid manifests; the CLI will surface parse errors separately.
        }
      }
    }
  }
  return manifests;
}
