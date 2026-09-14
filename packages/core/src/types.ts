/**
 * TypeScript types for the API Migration Manifest format (schema: schemas/manifest.schema.json).
 */

export type ChangeSeverity = 'breaking' | 'deprecation' | 'feature';
export type ChangeKind =
  | 'renamed-call'
  | 'removed-parameter'
  | 'renamed-parameter'
  | 'changed-parameter-type'
  | 'renamed-field'
  | 'removed-field'
  | 'renamed-enum-value'
  | 'sdk-upgrade'
  | 'deprecated-call'
  | 'endpoint-removed'
  | 'endpoint-deprecated'
  | 'response-field-changed'
  | 'request-field-changed';

/** Enterprise risk rating assigned to a migration. */
export type RiskRating = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ManifestMatch {
  call?: { name: string; object?: string };
  field?: { name: string; object?: string };
  parameter?: { name: string };
  sdk?: { package: string; minVersion?: string };
  /** Telemetry / sunset header rule: match code that depends on a
   * deprecation/sunset header or a deprecated SDK header. */
  telemetry?: { header: string; value?: string };
  /** Match an OpenAPI operation (path + method). */
  endpoint?: { path: string; method?: string };
}

export interface ManifestFix {
  kind:
    | 'rename-call'
    | 'rename-field'
    | 'rename-parameter'
    | 'remove-parameter'
    | 'rename-enum-value'
    | 'convert-amount'
    | 'replace';
  from?: string;
  to?: string;
  value?: string;
  explain?: string;
}

export interface ManifestChange {
  type: ChangeKind;
  description: string;
  match?: ManifestMatch;
  fix?: ManifestFix;
  /** Optional explicit risk rating; otherwise derived by the risk engine. */
  risk?: RiskRating;
}

export interface MigrationManifest {
  schemaVersion: '1.0';
  id: string;
  vendor: string;
  title: string;
  severity: ChangeSeverity;
  lang: string;
  changedAt: string;
  references?: string[];
  changes: ManifestChange[];
  /** OpenAPI/AsyncAPI contract that this manifest was derived from (ingester). */
  sourceContract?: string;
}

export interface ScanHit {
  /** Manifest ID the hit came from. */
  manifestId: string;
  /** Change index within the manifest. */
  changeIndex: number;
  /** Change kind, e.g. 'renamed-call'. */
  kind: ChangeKind;
  /** File path relative to the repo root. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column. */
  column: number;
  /** The matched source text (the call/field/parameter). */
  snippet: string;
  /** 0..1 confidence that this is a real affected usage, not a false positive. */
  confidence: number;
  /** Optional fix to apply, when the manifest defines one. */
  fix?: ManifestFix;
  /** Optional replacement text. */
  replacement?: string;
  /** Line range covered by the hit (multi-line matches). */
  lineRange?: { start: number; end: number };
  /**
   * FR-07: absolute 0-based char offsets into the original file, for
   * source-scoped edits. Present when the scanner could resolve an exact
   * symbol location. The codemod must verify `content.slice(offset,
   * endOffset) === snippet` before editing; hits without offsets are
   * report-only and must never be applied via text search.
   */
  offset?: number;
  endOffset?: number;
  /** Per-change risk rating (from manifest or risk engine). */
  risk?: RiskRating;
  /** Estimated blast radius metadata. */
  blastRadius?: BlastRadius;
}

export interface ScanReport {
  manifest: MigrationManifest;
  hits: ScanHit[];
  /** Files examined. */
  filesScanned: number;
  /** Total scan duration in ms. */
  durationMs: number;
}

/** Estimated blast radius of a migration within a codebase. */
export interface BlastRadius {
  /** Number of distinct files affected. */
  fileCount: number;
  /** Number of distinct call sites affected. */
  callSiteCount: number;
  /** Comma-separated list of affected files (truncated for display). */
  affectedFiles: string[];
  /** Optional set of dependent microservices/modules (from repo config). */
  affectedServices?: string[];
}

/** AI-assisted semantic codemod specification. */
export interface AiCodemodSpec {
  /** Id of the manifest change this codemod addresses. */
  changeIndex: number;
  /** Natural-language instruction given to the LLM. */
  prompt: string;
  /** Optional structured context (e.g. extracted surrounding code). */
  context?: string;
  /** Expected output format the executor validates against. */
  expectedOutcome: string;
}

/** Telemetry / sunset radar entry — a header or contract flag tracked over time. */
export interface TelemetryRule {
  /** Header name, e.g. 'Sunset', 'Deprecation', 'Stripe-Version'. */
  header: string;
  /** Optional expected value (e.g. a date or version). */
  value?: string;
  /** Severity when the rule fires. */
  severity: ChangeSeverity;
  /** Human description of what the header signals. */
  description: string;
}

/**
 * FR-08/FR-10: validation dimensions. Each dimension is reported separately —
 * no single green indicator hides missing dimensions.
 */
export type ValidationStatus = 'PASS' | 'FAIL' | 'NOT_RUN' | 'NOT_APPLICABLE' | 'INCONCLUSIVE';

export type ValidationDimensionName =
  | 'syntax'
  | 'dependency-resolution'
  | 'types-build'
  | 'unit-tests'
  | 'integration-tests'
  | 'contract-sandbox'
  | 'domain-behavior'
  | 'customer-acceptance';

export interface ValidationDimension {
  name: ValidationDimensionName;
  status: ValidationStatus;
  reason: string;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  /** Bounded, redacted log excerpt (never raw secrets). */
  logExcerpt?: string;
  testCounts?: { passed?: number; failed?: number; total?: number };
}

/** Overall candidate verdict. Only VERIFIED may open a migration PR. */
export type ValidationVerdict = 'VERIFIED' | 'FAILED' | 'INCOMPLETE';

export interface ValidationProfile {
  id: string;
  required: ValidationDimensionName[];
}

export interface ValidationRun {
  /** Immutable binding: every field that changes the candidate changes this. */
  candidateDigest: string;
  baseSha: string | null;
  profileId: string;
  verdict: ValidationVerdict;
  dimensions: ValidationDimension[];
  startedAt: string;
  finishedAt: string;
  toolVersions: Record<string, string | null>;
  /** Number of files in the candidate. */
  fileCount: number;
  /** Short digests per file for audit (path -> sha256[0:12]). */
  fileDigests: Record<string, string>;
}
