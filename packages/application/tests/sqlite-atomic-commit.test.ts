import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@raag/domain';
import type { ResolveResult } from '@raag/application';
import { parseRequestId } from '@raag/domain';
import { ApprovalManager } from '@raag/application';
import { openSqliteStore } from '@raag/database';
import { createFakeClock, pendingTestRequest } from '@raag/testing';

/**
 * Spec §11: "approval state = APPROVED while audit insert failed" must be
 * impossible. With SqliteStore (BEGIN IMMEDIATE + audit INSERT + CAS inside
 * ONE transaction) a throwing audit sink rolls back the whole commit.
 */
describe('ApprovalManager with SQLite store: decision + audit are one atomic commit', () => {
  function fixture() {
    const clock = createFakeClock(1_700_000_000_000);
    const store = openSqliteStore({ path: ':memory:', clock });
    let rejectNext = false;
    const audit = {
      async append(event: AuditEvent): Promise<void> {
        if (event.type === 'request-resolved' && rejectNext) {
          throw new Error('simulated disk full');
        }
        await store.audit.append(event);
      },
      forRequest: store.audit.forRequest.bind(store.audit),
      count: store.audit.count.bind(store.audit),
    };
    const manager = new ApprovalManager({
      repository: store.repository,
      audit,
      clock,
      tx: store.transactionScope,
    });
    const submitter = async (rid: string) => {
      const req = pendingTestRequest({
        requestId: rid,
        ttlSeconds: 60,
        action: {
          tool: 'Bash',
          displaySummary: 'run: make deploy',
          payloadSha256: 'f'.repeat(64),
          payloadBytes: 220,
        },
      });
      // create the record exactly as submit does, but pre-settled:
      await store.repository.add(req);
      return manager.get(parseRequestId(rid));
    };
    return { store, clock, manager, audit, reject: () => (rejectNext = true), submitter };
  }

  it('a failing audit append on the decided path rolls back the state write too', async () => {
    const { store, manager, audit, reject, submitter } = fixture();
    await submitter('req-atomic-1');
    reject();
    const res: ResolveResult = await manager.decide('req-atomic-1' as never, 'allow-once');
    expect(res.outcome).toBe('audit-failed');
    // state never stored:
    const stored = await store.repository.findById('req-atomic-1' as never);
    expect(stored?.state).toBe('pending');
    // and the rolled-back transaction left NO request-resolved audit row:
    expect(
      audit.forRequest('req-atomic-1').filter((r) => r['type'] === 'request-resolved'),
    ).toHaveLength(0);
    store.close();
  });

  it('the same decision succeeds once the audit path is healthy', async () => {
    const { store, manager, submitter } = fixture();
    await submitter('req-retry-1');
    const res = await manager.decide('req-retry-1' as never, 'allow-once');
    expect(res.outcome).toBe('advanced');
    expect((await store.repository.findById('req-retry-1' as never))?.state).toBe('approved');
    store.close();
  });

  it('exactly one concurrent decision wins; the loser is a typed conflict/duplicate; sweep skips terminals', async () => {
    const { store, manager, clock, submitter } = fixture();
    await submitter('req-race-1');
    const [a, b] = await Promise.all([
      manager.decide('req-race-1' as never, 'allow-once'),
      manager.decide('req-race-1' as never, 'deny'),
    ]);
    const winners = [a, b].filter((r) => r.outcome === 'advanced');
    const losers = [a, b].filter((r) => r.outcome === 'conflict' || r.outcome === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const final = await store.repository.findById('req-race-1' as never);
    expect(final?.state === 'approved' || final?.state === 'denied').toBe(true);
    clock.advance(61_000);
    expect(await manager.expireDue()).toEqual([]); // terminal never expires again
    expect((await store.repository.findById('req-race-1' as never))?.state).toBe(final?.state);
    store.close();
  });
});
