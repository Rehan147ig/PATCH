/**
 * §9 workflow concurrency: transactional outbox, idempotent consumers,
 * bounded retries, leases/heartbeats, dead-letter handling, reconciler.
 * No distributed exactly-once promise: GitHub-side success is reconciled
 * before DB commit; retries never duplicate (candidate-specific branches).
 */

export interface OutboxMessage {
  id: string;
  aggregate: string;
  kind: string;
  payload: Record<string, unknown>;
  /** Idempotency key: consumer dedupes on this. */
  idempotencyKey: string;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
}

export const MAX_ATTEMPTS = 5;

export function backoffForAttempt(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** attempt);
}

/** Transactional outbox: enqueue atomically with the DB write (same tick). */
export class TransactionalOutbox {
  private pending: OutboxMessage[] = [];
  private seq = 1;

  enqueue(aggregate: string, kind: string, payload: Record<string, unknown>, idempotencyKey: string, at = Date.now()): OutboxMessage {
    const msg: OutboxMessage = {
      id: `msg_${this.seq++}`, aggregate, kind, payload,
      idempotencyKey, attempts: 0, nextAttemptAt: at, createdAt: at,
    };
    this.pending.push(msg);
    return msg;
  }

  /** Claim due messages for a worker (lease = visible timeout). */
  claim(limit: number, leaseMs: number, at = Date.now()): OutboxMessage[] {
    const due = this.pending.filter((m) => m.nextAttemptAt <= at).slice(0, limit);
    for (const m of due) m.nextAttemptAt = at + leaseMs; // heartbeat window
    return due;
  }

  ack(id: string): void {
    this.pending = this.pending.filter((m) => m.id !== id);
  }

  /** Nack with bounded retry; exhaust → DLQ handoff (returns true when dead). */
  nack(id: string, at = Date.now()): boolean {
    const m = this.pending.find((x) => x.id === id);
    if (!m) return false;
    m.attempts += 1;
    if (m.attempts >= MAX_ATTEMPTS) return true;
    m.nextAttemptAt = at + backoffForAttempt(m.attempts);
    return false;
  }

  heartbeat(id: string, leaseMs: number, at = Date.now()): boolean {
    const m = this.pending.find((x) => x.id === id);
    if (!m) return false;
    m.nextAttemptAt = at + leaseMs;
    return true;
  }

  get size(): number {
    return this.pending.length;
  }
}

/** Idempotent consumer: same idempotencyKey executes once. */
export class IdempotentConsumer {
  private seen = new Set<string>();

  consume<T>(key: string, fn: () => T): { result?: T; duplicate: boolean } {
    if (this.seen.has(key)) return { duplicate: true };
    const result = fn();
    this.seen.add(key);
    return { result, duplicate: false };
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }
}

export interface DeadLetter {
  message: OutboxMessage;
  reason: string;
  deadAt: number;
}

export class DeadLetterQueue {
  private letters: DeadLetter[] = [];

  push(message: OutboxMessage, reason: string, at = Date.now()): void {
    this.letters.push({ message, reason, deadAt: at });
  }

  list(): DeadLetter[] {
    return [...this.letters];
  }

  get size(): number {
    return this.letters.length;
  }
}

/**
 * Reconciler: GitHub-side success wins. If the PR exists remotely but the DB
 * commit never landed (worker died after create), reconcile to the single
 * remote PR instead of opening a second one. Returns the reconciled PR.
 */
export async function reconcileDelivery<T extends { url: string; number: number }>(
  findRemote: () => Promise<T | null>,
  createRemote: () => Promise<T>,
  recordDb: (pr: T) => Promise<void>,
): Promise<{ pr: T; reconciled: boolean }> {
  const before = await findRemote();
  if (before) {
    await recordDb(before);
    return { pr: before, reconciled: true };
  }
  let pr: T;
  try {
    pr = await createRemote();
  } catch (err) {
    // Lost race: another worker created it concurrently.
    const raced = await findRemote();
    if (raced) {
      await recordDb(raced);
      return { pr: raced, reconciled: true };
    }
    throw err;
  }
  // Durability: confirm remote state before DB commit (worker-die-after-create
  // retries land here via the `before` branch and reconcile to one PR).
  const remote = await findRemote();
  await recordDb(remote ?? pr);
  return { pr: remote ?? pr, reconciled: false };
}
