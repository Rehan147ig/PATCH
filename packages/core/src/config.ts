/**
 * §16 open decisions: owner-configured knobs with test adapters.
 * Never represent absent credentials or external evidence as completed
 * deployment: every accessor reports `configured` explicitly.
 */

export interface PatchConfig {
  firstMigration?: { provider: string; changeFamily: string } | null;
  runnerHosting: 'customer' | 'hosted' | 'undecided';
  githubApp?: { appId?: string; domain?: string } | null;
  codeToModelPolicy: 'no-external-model' | 'redacted-excerpts' | 'undecided';
  planLimits?: { maxRepos: number; maxMigrationsPerMonth: number } | null;
  productionRegion?: string | null;
  paymentProcessor?: string | null;
  retentionTerms?: { checkoutHrs: number; evidenceDays: number; auditDays: number } | null;
}

export const UNDECIDED_CONFIG: PatchConfig = {
  firstMigration: null,
  runnerHosting: 'undecided',
  githubApp: null,
  codeToModelPolicy: 'undecided',
  planLimits: null,
  productionRegion: null,
  paymentProcessor: null,
  retentionTerms: null,
};

export function isConfigured(config: PatchConfig): { configured: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!config.firstMigration) missing.push('firstMigration');
  if (config.runnerHosting === 'undecided') missing.push('runnerHosting');
  if (!config.githubApp?.appId || !config.githubApp?.domain) missing.push('githubApp');
  if (config.codeToModelPolicy === 'undecided') missing.push('codeToModelPolicy');
  if (!config.planLimits) missing.push('planLimits');
  if (!config.productionRegion) missing.push('productionRegion');
  if (!config.paymentProcessor) missing.push('paymentProcessor');
  if (!config.retentionTerms) missing.push('retentionTerms');
  return { configured: missing.length === 0, missing };
}

/** Test adapter: local file runner + fake credentials clearly marked non-production. */
export function testAdapterConfig(): PatchConfig & { testAdapter: true } {
  return {
    ...UNDECIDED_CONFIG,
    firstMigration: { provider: 'openai', changeFamily: 'chat-completions' },
    runnerHosting: 'customer',
    codeToModelPolicy: 'no-external-model',
    testAdapter: true as const,
  };
}
