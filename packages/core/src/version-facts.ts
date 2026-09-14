/**
 * FR-03: Resolve actual usage versions + FR-05: separate exposure vs upgrade.
 * PRD §6: VersionFacts distinguish known / inferred / conflicting /
 * external-unknown. A lockfile is stronger evidence of installed SDK than a
 * range, but neither determines API-account or webhook version. Client
 * deployment names must not be interpreted as model versions without evidence.
 * PRD scenarios 3 (old major pinned → targeted upgrade still matches) and 4
 * (unknown account/webhook/model → needs-information, no guessed upgrade).
 */

export type VersionConfidence = 'known' | 'inferred' | 'conflicting' | 'external-unknown';

export interface VersionFacts {
  provider: string;
  /** Declared semver range from package.json (weak evidence). */
  declaredRange?: string | null;
  /** Resolved SDK version from lockfile (stronger evidence). */
  resolvedSdk?: string | null;
  /** API version header/default (e.g. Stripe-Version, OpenAI-Version). */
  apiHeader?: string | null;
  apiDefault?: string | null;
  /** Model identifier only when pinned (never guess from deployment names). */
  modelId?: string | null;
  modelPinned?: boolean;
  endpoint?: string | null;
  hostingPlatform?: string | null;
  webhookVersion?: string | null;
  confidence: VersionConfidence;
  conflicts: string[];
  needsInformation: string[];
}

export interface VersionInputs {
  provider: string;
  packageJson?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  /** map of package -> resolved version (parsed lockfile). */
  lockfile?: Record<string, string>;
  /** SDK package name, e.g. 'stripe' | 'openai'. */
  sdkPackage?: string;
  headers?: Record<string, string>;
  /** Model id only if from pinned config (model: 'gpt-4o-2024-08-06'). */
  pinnedModelId?: string;
  /** Deployment name (e.g. Azure deployment) — NEVER treated as model version. */
  deploymentName?: string;
  endpoint?: string;
  hostingPlatform?: string;
  webhookVersion?: string;
}

const BER = /[^0-9.]/g;
export function normalizeVersion(v: string): string {
  return v.replace(BER, '').split('.').filter(Boolean).join('.');
}

export function collectVersionFacts(inputs: VersionInputs): VersionFacts {
  const conflicts: string[] = [];
  const needsInformation: string[] = [];
  const pkg = inputs.sdkPackage;
  const declaredRange = pkg
    ? (inputs.packageJson?.dependencies?.[pkg] ?? inputs.packageJson?.devDependencies?.[pkg] ?? null)
    : null;
  const resolvedSdk = pkg ? (inputs.lockfile?.[pkg] ?? null) : null;

  if (declaredRange && resolvedSdk && !satisfiesRange(resolvedSdk, declaredRange)) {
    conflicts.push(`resolved ${resolvedSdk} does not satisfy declared ${declaredRange}`);
  }

  // Headers: explicit header wins over default; absence → external-unknown for account-scoped APIs.
  const apiHeader = inputs.headers?.['Stripe-Version'] ?? inputs.headers?.['OpenAI-Version'] ?? inputs.headers?.['stripe-version'] ?? null;
  const apiDefault = inputs.headers?.['default'] ?? null;

  // Model: only pinned ids count. Deployment names are ignored by design.
  let modelId: string | null = null;
  let modelPinned = false;
  if (inputs.pinnedModelId) {
    modelId = inputs.pinnedModelId;
    modelPinned = true;
  } else if (inputs.deploymentName) {
    needsInformation.push('model version unknown: deployment name is not a model version without pinned mapping');
  }

  if (inputs.provider === 'stripe' && !inputs.webhookVersion) {
    needsInformation.push('webhook version unknown: request exact endpoint secret version, do not guess');
  }
  if (!apiHeader && !apiDefault && (inputs.provider === 'stripe' || inputs.provider === 'openai')) {
    needsInformation.push('account/default API version unknown: request provider-dashboard version');
  }

  let confidence: VersionConfidence = 'known';
  if (conflicts.length > 0) confidence = 'conflicting';
  else if (needsInformation.length > 0) confidence = modelId || resolvedSdk ? 'inferred' : 'external-unknown';
  else if (!resolvedSdk && declaredRange) confidence = 'inferred';

  return {
    provider: inputs.provider,
    declaredRange, resolvedSdk, apiHeader, apiDefault,
    modelId, modelPinned,
    endpoint: inputs.endpoint ?? null,
    hostingPlatform: inputs.hostingPlatform ?? null,
    webhookVersion: inputs.webhookVersion ?? null,
    confidence, conflicts, needsInformation,
  };
}

/** Minimal semver range check: supports ^ ~ >= <= > < = and exact. */
export function satisfiesRange(version: string, range: string): boolean {
  const v = normalizeVersion(version);
  const r = range.trim();
  if (r === '*' || r === 'latest' || r === '') return true;
  const m = r.match(/^(>=|<=|>|<|\^|~|=)?\s*([0-9][0-9.]*)$/);
  if (!m) return true; // unknown range syntax → do not block (inferred)
  const [, op = '=', wantRaw] = m;
  const cmp = compareSemver(v, normalizeVersion(wantRaw));
  switch (op) {
    case '=': return cmp === 0;
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    case '^': return cmp >= 0; // simplified: same-major-or-newer counts as satisfying caret for exposure
    case '~': return cmp >= 0;
    default: return true;
  }
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ---- FR-05: exposure vs upgrade matching ----

/**
 * Current exposure: is the deployed code exposed to an admitted (currently
 * supported) version? Uses the admitted range, not the migration target.
 */
export function isExposedToVersion(deployed: string, admittedRange: string): boolean {
  return satisfiesRange(deployed, admittedRange);
}

/**
 * Upgrade applicability: a migration applies when its SOURCE range includes
 * the deployed version — even when current-exposure matching excludes the
 * new major (scenario 3: old major pinned still gets its targeted upgrade).
 */
export function upgradeApplies(deployed: string, sourceRange: string): boolean {
  return satisfiesRange(deployed, sourceRange);
}

/**
 * Scenario 4: unknown account/webhook/model version → needs-information,
 * never a guessed upgrade.
 */
export function needsInformationForUpgrade(facts: VersionFacts): string[] {
  return facts.needsInformation;
}
