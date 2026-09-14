/**
 * FR-01: Authenticate organizations and install/uninstall GitHub access.
 * PRD §4 acceptance: two-tenant tests; revoked installation stops fetch,
 * jobs, and PR delivery. PRD §15 scenario 15: access revoked + org deleted
 * → work stops, deletion verified under documented retention.
 *
 * All tenant data carries organization identity; every lookup is scoped by
 * orgId. Revocation flips Installation.status to 'revoked'|'uninstalled';
 * authorize() then denies fetch/scan/job/pr for that installation at the
 * next safe boundary (callers must check before each unit of work).
 */

export type InstallationStatus = 'active' | 'revoked' | 'uninstalled';

export interface Organization {
  id: string;
  name: string;
  createdAt: string;
  deletedAt?: string | null;
}

export interface Installation {
  id: string;
  orgId: string;
  githubInstallationId: number;
  status: InstallationStatus;
  selectedRepos: string[];
  readOnly: boolean;
  createdAt: string;
  revokedAt?: string | null;
}

export interface Repository {
  id: string;
  orgId: string;
  installationId: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

export type WorkKind = 'fetch' | 'scan' | 'job' | 'pr';

export interface AuthDecision {
  ok: boolean;
  reason?: 'unknown-org' | 'org-deleted' | 'unknown-installation' | 'revoked' | 'repo-mismatch' | 'read-only-denied';
}

const now = () => new Date().toISOString();

/** In-memory tenant store. Production backs this with Postgres + RLS; the
 * authorization semantics are identical and covered by two-tenant tests. */
export class TenantStore {
  private orgs = new Map<string, Organization>();
  private installs = new Map<string, Installation>();
  private repos = new Map<string, Repository>();
  private seq = 1;

  createOrg(name: string): Organization {
    const id = `org_${this.seq++}`;
    const org: Organization = { id, name, createdAt: now(), deletedAt: null };
    this.orgs.set(id, org);
    return org;
  }

  deleteOrg(orgId: string): void {
    const org = this.orgs.get(orgId);
    if (!org) return;
    org.deletedAt = now();
    // Revoke all installations: work stops at next authorize() boundary.
    for (const inst of this.installs.values()) {
      if (inst.orgId === orgId && inst.status === 'active') {
        inst.status = 'revoked';
        inst.revokedAt = now();
      }
    }
  }

  install(orgId: string, githubInstallationId: number, selectedRepos: string[], readOnly = false): Installation {
    const org = this.orgs.get(orgId);
    if (!org || org.deletedAt) throw new Error(`unknown or deleted org: ${orgId}`);
    const id = `ins_${this.seq++}`;
    const inst: Installation = {
      id, orgId, githubInstallationId, status: 'active',
      selectedRepos: [...selectedRepos], readOnly, createdAt: now(), revokedAt: null,
    };
    this.installs.set(id, inst);
    return inst;
  }

  /** Revoke/uninstall: cancels queued/in-flight work at next safe boundary. */
  revoke(installationId: string, status: InstallationStatus = 'revoked'): void {
    const inst = this.installs.get(installationId);
    if (!inst) return;
    inst.status = status;
    inst.revokedAt = now();
  }

  addRepo(orgId: string, installationId: string, owner: string, name: string, defaultBranch = 'main'): Repository {
    const inst = this.installs.get(installationId);
    if (!inst || inst.orgId !== orgId) throw new Error('installation does not belong to org');
    const id = `repo_${this.seq++}`;
    const repo: Repository = { id, orgId, installationId, owner, name, defaultBranch };
    this.repos.set(id, repo);
    return repo;
  }

  /**
   * Authorize a unit of work. Must be called before fetch, scan chunk, job
   * lease, and PR delivery (next safe boundary).
   */
  authorize(orgId: string, installationId: string, repoId: string, kind: WorkKind): AuthDecision {
    const org = this.orgs.get(orgId);
    if (!org) return { ok: false, reason: 'unknown-org' };
    if (org.deletedAt) return { ok: false, reason: 'org-deleted' };
    const inst = this.installs.get(installationId);
    if (!inst || inst.orgId !== orgId) return { ok: false, reason: 'unknown-installation' };
    if (inst.status !== 'active') return { ok: false, reason: 'revoked' };
    const repo = this.repos.get(repoId);
    if (!repo || repo.orgId !== orgId || repo.installationId !== installationId) {
      return { ok: false, reason: 'repo-mismatch' };
    }
    if (kind === 'pr' && inst.readOnly) return { ok: false, reason: 'read-only-denied' };
    return { ok: true };
  }

  /** Tenant-scoped listing: never leaks across orgs. */
  listRepos(orgId: string): Repository[] {
    return [...this.repos.values()].filter((r) => r.orgId === orgId);
  }

  getInstallation(id: string): Installation | undefined {
    return this.installs.get(id);
  }
}
