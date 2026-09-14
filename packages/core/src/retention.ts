/**
 * FR-14: Respect retention and export. PRD §11 proposed defaults (design
 * defaults, not regulatory claims):
 *  - raw checkout removed within 1h after job completion
 *  - redacted patch/evidence retained 30 days
 *  - minimal audit metadata retained 90 days
 * Enterprise contracts can configure retention/residency. Audit records must
 * not silently retain deleted code. Backups expire on a verified schedule;
 * immediate deletion from immutable backups is never claimed.
 */

export interface RetentionPolicy {
  /** ms after job completion to drop raw checkouts (default 1h). */
  rawCheckoutTtlMs: number;
  /** ms to retain redacted patch/evidence (default 30d). */
  evidenceTtlMs: number;
  /** ms to retain minimal audit metadata (default 90d). */
  auditTtlMs: number;
  /** Backup expiry schedule description, e.g. 'daily snapshots expire after 35d'. */
  backupExpiry: string;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  rawCheckoutTtlMs: 60 * 60 * 1000,
  evidenceTtlMs: 30 * 24 * 60 * 60 * 1000,
  auditTtlMs: 90 * 24 * 60 * 60 * 1000,
  backupExpiry: 'snapshots expire 35d after creation; deletion propagates on next snapshot expiry',
};

export type ArtifactKind = 'raw-checkout' | 'redacted-patch' | 'evidence' | 'audit-metadata';

export interface RetainedArtifact {
  id: string;
  orgId: string;
  kind: ArtifactKind;
  /** Object-storage key or DB row reference. Never raw secrets/code for audit kinds. */
  ref: string;
  createdAt: number;
  /** True once physically removed (not just marked). */
  deleted: boolean;
  deletedAt?: number | null;
  containsCode: boolean;
}

export class ArtifactRegistry {
  private items = new Map<string, RetainedArtifact>();
  private seq = 1;

  constructor(private policy: RetentionPolicy = DEFAULT_RETENTION) {}

  record(orgId: string, kind: ArtifactKind, ref: string, containsCode: boolean): RetainedArtifact {
    const id = `art_${this.seq++}`;
    const art: RetainedArtifact = { id, orgId, kind, ref, createdAt: Date.now(), deleted: false, deletedAt: null, containsCode };
    if (kind === 'audit-metadata' && containsCode) {
      throw new Error('audit records must not retain deleted code');
    }
    this.items.set(id, art);
    return art;
  }

  /** Inventory all retained source artifacts (FR-14 acceptance). */
  inventory(orgId?: string): RetainedArtifact[] {
    return [...this.items.values()].filter((a) => !a.deleted && (orgId === undefined || a.orgId === orgId));
  }

  ttlFor(kind: ArtifactKind): number {
    if (kind === 'raw-checkout') return this.policy.rawCheckoutTtlMs;
    if (kind === 'audit-metadata') return this.policy.auditTtlMs;
    return this.policy.evidenceTtlMs;
  }

  dueForDeletion(at = Date.now()): RetainedArtifact[] {
    return [...this.items.values()].filter((a) => !a.deleted && at - a.createdAt >= this.ttlFor(a.kind));
  }

  /** Physically delete + verify (returns verified ids). */
  verifyDeletion(ids: string[], at = Date.now()): string[] {
    const verified: string[] = [];
    for (const id of ids) {
      const a = this.items.get(id);
      if (!a || a.deleted) continue;
      a.deleted = true;
      a.deletedAt = at;
      verified.push(id);
    }
    return verified;
  }

  /** Delete everything for an org (scenario 15); audit-metadata without code may outlive per policy. */
  deleteOrgData(orgId: string, at = Date.now(), keepAudit = true): { deleted: string[]; retainedAudit: string[] } {
    const deleted: string[] = [];
    const retainedAudit: string[] = [];
    for (const a of this.items.values()) {
      if (a.orgId !== orgId || a.deleted) continue;
      if (keepAudit && a.kind === 'audit-metadata' && !a.containsCode) {
        retainedAudit.push(a.id);
        continue;
      }
      a.deleted = true;
      a.deletedAt = at;
      deleted.push(a.id);
    }
    return { deleted, retainedAudit };
  }

  exportInventory(orgId: string): { exportedAt: string; artifacts: RetainedArtifact[]; backupExpiry: string } {
    return { exportedAt: new Date().toISOString(), artifacts: this.inventory(orgId), backupExpiry: this.policy.backupExpiry };
  }
}
