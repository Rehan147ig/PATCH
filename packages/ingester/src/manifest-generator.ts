import type { ContractDiff } from './openapi-diff.js';
import type { MigrationManifest, ChangeKind } from '@apimigrate/core';

/**
 * Compile an OpenAPI contract diff into one or more validated apimigrate
 * manifests. Each manifest groups changes for a single vendor, with a
 * generated id and references pointing at the source contract.
 */
export interface ManifestCompileOptions {
  vendor: string;
  /** Human title, e.g. 'Acme API — October 2026 contract changes'. */
  title: string;
  /** Effective date of the change, ISO date. */
  changedAt: string;
  /** Optional URL of the source contract / changelog. */
  sourceContract?: string;
  lang?: string;
  /** Optional suffix for the manifest id. */
  idSuffix?: string;
}

/** Map a contract diff entry to a manifest change kind. */
export function classifyChange(entry: DiffEntry): ChangeKind {
  switch (entry.type) {
    case 'removed-operation':
      return 'endpoint-removed';
    case 'deprecated-operation':
      return 'endpoint-deprecated';
    case 'removed-parameter':
      return 'removed-parameter';
    case 'renamed-parameter':
      return 'renamed-parameter';
    case 'removed-request-field':
    case 'removed-response-field':
      return 'removed-field';
    case 'new-required-request-field':
      return 'request-field-changed';
    case 'type-change':
      return 'changed-parameter-type';
  }
}

export type DiffEntry =
  | { type: 'removed-operation'; path: string; method: string }
  | { type: 'deprecated-operation'; path: string; method: string }
  | { type: 'removed-parameter'; path: string; method: string; name: string }
  | { type: 'renamed-parameter'; path: string; method: string; from: string; to: string }
  | { type: 'removed-request-field'; path: string; method: string; field: string }
  | { type: 'removed-response-field'; path: string; method: string; field: string }
  | { type: 'new-required-request-field'; path: string; method: string; field: string }
  | { type: 'type-change'; path: string; method: string; name: string; from: string; to: string };

/** Flatten a ContractDiff into uniform entries. */
export function flattenDiff(diff: ContractDiff): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const op of diff.removedOperations) {
    const [method, ...rest] = op.split(' ');
    entries.push({ type: 'removed-operation', method, path: rest.join(' ') });
  }
  for (const op of diff.newlyDeprecated) {
    const [method, ...rest] = op.split(' ');
    entries.push({ type: 'deprecated-operation', method, path: rest.join(' ') });
  }
  for (const p of diff.removedParameters) entries.push({ type: 'removed-parameter', ...p });
  for (const p of diff.renamedParameters) entries.push({ type: 'renamed-parameter', ...p });
  for (const f of diff.removedRequestFields) entries.push({ type: 'removed-request-field', ...f });
  for (const f of diff.removedResponseFields) entries.push({ type: 'removed-response-field', ...f });
  for (const f of diff.newRequiredRequestFields) entries.push({ type: 'new-required-request-field', ...f });
  for (const t of diff.typeChanges) entries.push({ type: 'type-change', ...t });
  return entries;
}

function describe(entry: DiffEntry): string {
  switch (entry.type) {
    case 'removed-operation':
      return `The ${entry.method.toUpperCase()} ${entry.path} endpoint has been removed.`;
    case 'deprecated-operation':
      return `The ${entry.method.toUpperCase()} ${entry.path} endpoint is deprecated and will be sunset.`;
    case 'removed-parameter':
      return `The \`${entry.name}\` parameter on ${entry.method.toUpperCase()} ${entry.path} has been removed.`;
    case 'renamed-parameter':
      return `The \`${entry.from}\` parameter on ${entry.method.toUpperCase()} ${entry.path} has been renamed to \`${entry.to}\`.`;
    case 'removed-request-field':
      return `The request field \`${entry.field}\` on ${entry.method.toUpperCase()} ${entry.path} has been removed.`;
    case 'removed-response-field':
      return `The response field \`${entry.field}\` on ${entry.method.toUpperCase()} ${entry.path} has been removed.`;
    case 'new-required-request-field':
      return `The request field \`${entry.field}\` on ${entry.method.toUpperCase()} ${entry.path} is now required.`;
    case 'type-change':
      return `The \`${entry.name}\` parameter/field on ${entry.method.toUpperCase()} ${entry.path} changed type from \`${entry.from}\` to \`${entry.to}\`.`;
  }
}

/** Build a match pattern for an entry (endpoint + optional param/field). */
function matchFor(entry: DiffEntry) {
  const base = {
    endpoint: { path: entry.path, method: entry.method },
  };
  switch (entry.type) {
    case 'removed-parameter':
    case 'new-required-request-field':
      return { ...base, parameter: { name: entry.type === 'removed-parameter' ? entry.name : entry.field } };
    case 'removed-request-field':
    case 'removed-response-field':
      return { ...base, field: { name: entry.type === 'removed-request-field' ? entry.field : entry.field } };
    case 'renamed-parameter':
      return { ...base, parameter: { name: entry.from } };
    case 'type-change':
      return { ...base, parameter: { name: entry.name } };
    default:
      return base;
  }
}

/**
 * Compile a diff into a manifest. Entries with the same endpoint+kind are
 * merged into a single change description.
 */
export function compileManifest(diff: ContractDiff, opts: ManifestCompileOptions): MigrationManifest {
  const entries = flattenDiff(diff);
  const seen = new Set<string>();
  const changes: MigrationManifest['changes'] = [];

  for (const entry of entries) {
    const key = `${entry.type}|${entry.path}|${entry.method}|'name' in entry ? entry.name : ''|'field' in entry ? entry.field : ''|'from' in entry ? entry.from : ''`;
    if (seen.has(key)) continue;
    seen.add(key);
    changes.push({
      type: classifyChange(entry),
      description: describe(entry),
      match: matchFor(entry),
    });
  }

  if (changes.length === 0) {
    // No diff — still emit a manifest so the catalog lists it.
    changes.push({
      type: 'deprecated-call',
      description: 'No breaking changes detected in this contract diff.',
    });
  }

  const suffix = opts.idSuffix ? `-${opts.idSuffix}` : '';
  return {
    schemaVersion: '1.0',
    id: `${opts.vendor}-${opts.changedAt.replace(/-/g, '')}${suffix}`,
    vendor: opts.vendor,
    title: opts.title,
    severity: entries.some((e) => e.type === 'removed-operation' || e.type === 'removed-request-field' || e.type === 'removed-response-field')
      ? 'breaking'
      : 'deprecation',
    lang: opts.lang ?? 'typescript',
    changedAt: opts.changedAt,
    references: opts.sourceContract ? [opts.sourceContract] : undefined,
    sourceContract: opts.sourceContract,
    changes,
  };
}

/** Convenience: load two OpenAPI JSON strings and produce a manifest. */
export async function compileManifestFromSpecs(
  oldSpec: unknown,
  newSpec: unknown,
  opts: ManifestCompileOptions,
): Promise<MigrationManifest> {
  const { diffOpenApi } = await import('./openapi-diff.js');
  const diff = diffOpenApi(oldSpec as Parameters<typeof diffOpenApi>[0], newSpec as Parameters<typeof diffOpenApi>[0]);
  return compileManifest(diff, opts);
}
