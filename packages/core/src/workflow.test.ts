import { describe, it, expect } from 'vitest';
import { TransactionalOutbox, IdempotentConsumer, DeadLetterQueue, reconcileDelivery } from './workflow.js';

describe('§9 outbox + idempotent consumer + DLQ', () => {
  it('enqueues, leases with heartbeat, retries bounded then dead-letters', () => {
    const outbox = new TransactionalOutbox();
    const dlq = new DeadLetterQueue();
    const m = outbox.enqueue('case_1', 'verify', { digest: 'abc' }, 'idem-1', 0);
    expect(outbox.claim(10, 1000, 0).map((x) => x.id)).toEqual([m.id]);
    expect(outbox.heartbeat(m.id, 1000, 500)).toBe(true);
    for (let i = 0; i < 4; i++) expect(outbox.nack(m.id, 1000)).toBe(false);
    expect(outbox.nack(m.id, 1000)).toBe(true);
    dlq.push(m, 'bounded retries exhausted', 2000);
    outbox.ack(m.id);
    expect(outbox.size).toBe(0);
    expect(dlq.size).toBe(1);
  });

  it('idempotent consumer executes once per key', () => {
    const c = new IdempotentConsumer();
    let n = 0;
    expect(c.consume('k', () => ++n)).toEqual({ result: 1, duplicate: false });
    expect(c.consume('k', () => ++n)).toEqual({ duplicate: true });
    expect(n).toBe(1);
  });

  it('reconciler never duplicates: pre-existing, race, and fresh paths', async () => {
    const recorded: Array<{ url: string; number: number }> = [];
    const record = async (pr: { url: string; number: number }) => { recorded.push(pr); };
    // Pre-existing remote wins.
    const r1 = await reconcileDelivery(
      async () => ({ url: 'u/1', number: 1 }),
      async () => ({ url: 'u/2', number: 2 }),
      record,
    );
    expect(r1).toMatchObject({ reconciled: true });
    // Lost race on create reconciles.
    let calls = 0;
    const r2 = await reconcileDelivery(
      async () => (calls++ === 0 ? null : { url: 'u/9', number: 9 }),
      async () => { calls++; throw Object.assign(new Error('exists'), { status: 422 }); },
      record,
    );
    expect(r2.pr.number).toBe(9);
    expect(r2.reconciled).toBe(true);
    // Fresh create records once.
    const r3 = await reconcileDelivery(
      async () => null,
      async () => ({ url: 'u/3', number: 3 }),
      record,
    );
    expect(r3.reconciled).toBe(false);
    expect(recorded).toHaveLength(3);
  });
});
