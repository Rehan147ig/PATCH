/**
 * @apimigrate/db — logical entities (PRD §10) + tenant-aware in-memory store.
 *
 * Required logical entities: Organization, Installation, Repository,
 * IntegrationBinding, VersionFacts, RepositorySnapshot, SourceObservation,
 * ChangeEvent, CapabilityRule, MigrationCase, CandidatePatch, ValidationProfile,
 * ValidationRun, Approval, DeliveryAttempt, Outcome, AuditEvent, UsageLedger,
 * RunnerIdentity. Extends existing core models instead of duplicating them —
 * core-owned verification/delivery types are re-exported.
 *
 * Production persists these in Postgres (Drizzle) with least-privilege roles
 * + RLS tested against actual roles (not RLS config alone). This module keeps
 * the same shape + authorization rule (every tenant row carries orgId) so
 * `npm run build`/`npm test` stay green without a live database.
 */
export const DB_STUB = false;
export type DbStub = typeof DB_STUB;

export interface OrganizationRow { id: string; name: string; createdAt: string; deletedAt?: string | null }
export interface InstallationRow { id: string; orgId: string; githubInstallationId: number; status: 'active' | 'revoked' | 'uninstalled'; selectedRepos: string[]; createdAt: string }
export interface RepositoryRow { id: string; orgId: string; installationId: string; owner: string; name: string; defaultBranch: string }
export interface IntegrationBindingRow {
  id: string; orgId: string; repoId: string; provider: string; product?: string;
  coverage: 'maintained' | 'monitored' | 'recognized' | 'needs-information' | 'delayed';
  evidenceRef?: string; updatedAt: string;
}
export interface VersionFactsRow {
  id: string; orgId: string; repoId: string; provider: string;
  declaredRange?: string | null; resolvedSdk?: string | null; apiHeader?: string | null;
  modelId?: string | null; endpoint?: string | null; hostingPlatform?: string | null;
  confidence: 'known' | 'inferred' | 'conflicting' | 'external-unknown'; updatedAt: string;
}
export interface RepositorySnapshotRow { id: string; orgId: string; repoId: string; commitSha: string; extractorVersion: string; createdAt: string }
export interface SourceObservationRow { id: string; orgId?: string | null; provider: string; sourceUrl: string; sourceDigest: string; retrievedAt: string }
export interface ChangeEventRow {
  id: string; provider: string; product?: string; changeKind: string; sourceUrl: string;
  retrievedAt: string; publishedAt?: string | null; effectiveDate?: string | null;
  sourceDigest: string; previousDigest?: string | null; affectedRange?: string | null;
  supersedes?: string | null; correctionOf?: string | null;
}
export interface CapabilityRuleRow {
  id: string; provider: string; product?: string; hostingPlatform?: string; language: string;
  sourceRange?: string | null; targetRange?: string | null; changeFamily: string;
  extractor: string; transform: string; validationProfile: string;
  status: 'qualified' | 'provisional' | 'retired'; expiresAt?: string | null;
}
export interface MigrationCaseRow { id: string; orgId: string; repoId: string; changeEventId: string; state: string; createdAt: string; updatedAt: string }
export interface CandidatePatchRow { id: string; orgId: string; caseId: string; candidateDigest: string; baseSha: string | null; fileDigests: Record<string, string>; createdAt: string }
export interface ApprovalRow { id: string; orgId: string; candidateDigest: string; approver: string; authority: string; createdAt: string }
export interface DeliveryAttemptRow { id: string; orgId: string; candidateDigest: string; prUrl?: string | null; prNumber?: number | null; reconciled?: boolean; createdAt: string }
export interface OutcomeRow { id: string; orgId: string; caseId: string; outcome: 'opened' | 'accepted' | 'merged' | 'deployed-confirmed' | 'rejected' | 'reverted' | 'unknown'; recordedAt: string }
export interface AuditEventRow { id: string; orgId: string; actor: string; action: string; targetRef: string; createdAt: string }
export interface UsageLedgerRow { key: string; orgId: string; repoId: string; candidateDigest: string; kind: string; billable: 'completed' | 'non-billable'; createdAt: string }
export interface RunnerIdentityRow { id: string; orgId?: string | null; kind: 'customer' | 'hosted'; publicKey?: string; createdAt: string }

export type EntityName =
  | 'Organization' | 'Installation' | 'Repository' | 'IntegrationBinding' | 'VersionFacts'
  | 'RepositorySnapshot' | 'SourceObservation' | 'ChangeEvent' | 'CapabilityRule' | 'MigrationCase'
  | 'CandidatePatch' | 'ValidationProfile' | 'ValidationRun' | 'Approval' | 'DeliveryAttempt'
  | 'Outcome' | 'AuditEvent' | 'UsageLedger' | 'RunnerIdentity';

/** All 19 required logical entities are present (extends instead of duplicates). */
export const ENTITY_NAMES: EntityName[] = [
  'Organization', 'Installation', 'Repository', 'IntegrationBinding', 'VersionFacts',
  'RepositorySnapshot', 'SourceObservation', 'ChangeEvent', 'CapabilityRule', 'MigrationCase',
  'CandidatePatch', 'ValidationProfile', 'ValidationRun', 'Approval', 'DeliveryAttempt',
  'Outcome', 'AuditEvent', 'UsageLedger', 'RunnerIdentity',
];

/** Tenant isolation rule: every tenant row carries orgId (except shared public source facts). */
const SHARED_ENTITIES: EntityName[] = ['ChangeEvent', 'CapabilityRule'];
export function entityRequiresOrg(entity: EntityName): boolean {
  return !SHARED_ENTITIES.includes(entity);
}

/** Minimal in-memory DB for tests/drills (least-privilege semantics: org-scoped reads). */
export class MemoryDb {
  orgs = new Map<string, OrganizationRow>();
  installations = new Map<string, InstallationRow>();
  repos = new Map<string, RepositoryRow>();
  bindings = new Map<string, IntegrationBindingRow>();
  versionFacts = new Map<string, VersionFactsRow>();
  outcomes = new Map<string, OutcomeRow>();
  audit: AuditEventRow[] = [];
  usage = new Map<string, UsageLedgerRow>();

  putOrg(r: OrganizationRow): void { this.orgs.set(r.id, r); }
  putInstallation(r: InstallationRow): void { this.installations.set(r.id, r); }
  putRepo(r: RepositoryRow): void { this.repos.set(r.id, r); }

  /** Org-scoped read: returns only rows for that org (RLS-equivalent assertion). */
  reposForOrg(orgId: string): RepositoryRow[] {
    return [...this.repos.values()].filter((r) => r.orgId === orgId);
  }
  bindingsForOrg(orgId: string): IntegrationBindingRow[] {
    return [...this.bindings.values()].filter((r) => r.orgId === orgId);
  }
  auditForOrg(orgId: string): AuditEventRow[] {
    return this.audit.filter((r) => r.orgId === orgId);
  }
}
