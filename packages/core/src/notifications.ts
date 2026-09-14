/**
 * FR-12: Keep noise low. No notification for irrelevant changes; grouped
 * migrations; explicit opt-in digest; actionable deadline reminders.
 */
import type { ChangeEvent } from './change-event.js';

export interface NotificationPreference {
  orgId: string;
  /** Explicit opt-in to periodic digest (default off — no unsolicited digests). */
  digestOptIn: boolean;
  actionableOnly: boolean;
}

export interface MigrationNotice {
  orgId: string;
  repoId: string;
  changeEventId: string;
  provider: string;
  title: string;
  effectiveDate?: string | null;
  affected: boolean;
  groupedWith?: string[];
}

export function shouldNotify(
  notice: Pick<MigrationNotice, 'affected'>,
  event: Pick<ChangeEvent, 'kind'>,
): boolean {
  // Irrelevant/additive changes stay quiet.
  if (!notice.affected) return false;
  if (event.kind === 'optional-feature') return false;
  return true;
}

/** Group notices by provider + effective week (one PR thread per group). */
export function groupNotices(notices: MigrationNotice[]): MigrationNotice[][] {
  const groups = new Map<string, MigrationNotice[]>();
  for (const n of notices) {
    const week = n.effectiveDate ? n.effectiveDate.slice(0, 7) : 'no-date';
    const key = `${n.provider}|${week}`;
    const g = groups.get(key) ?? [];
    g.push(n);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** Actionable deadline reminders: upcoming + affected + within window. */
export function deadlineReminders(
  notices: MigrationNotice[],
  events: Map<string, Pick<ChangeEvent, 'effectiveDate' | 'datePrecision'>>,
  at = Date.now(),
  windowDays = 14,
): MigrationNotice[] {
  return notices.filter((n) => {
    if (!n.affected) return false;
    const ev = events.get(n.changeEventId);
    if (!ev?.effectiveDate) return false;
    const t = Date.parse(ev.effectiveDate);
    if (isNaN(t) || t <= at) return false; // historical/currently-unavailable is not an upcoming reminder
    return t - at <= windowDays * 86400000;
  });
}
