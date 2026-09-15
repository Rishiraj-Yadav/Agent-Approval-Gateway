import { describe, expect, it } from 'vitest';
import { createAuditEvent } from '@raag/domain';
import {
  InMemoryApprovalRepository,
  InMemoryAuditSink,
  inMemoryTransactionScope,
} from '@raag/database';
import { createFakeClock, pendingTestRequest } from '@raag/testing';

const clock = createFakeClock(1_700_000_000_000);

describe('inMemoryTransactionScope (§11 cooperative mirror of SQLite transactions)', () => {
  it('commits when fn resolves (all writes visible)', async () => {
    const repo = new InMemoryApprovalRepository();
    const auditSink = new InMemoryAuditSink();
    const tx = inMemoryTransactionScope(repo, auditSink);
    const req = pendingTestRequest({ requestId: 'req-mtx-ok' });
    await tx.run(async () => {
      await repo.add(req);
      await auditSink.append(
        createAuditEvent({
          type: 'request-created',
          occurredAt: clock.now(),
          actor: 'system',
          severity: 'info',
          requestId: req.requestId,
        }),
      );
    });
    expect(await repo.findById('req-mtx-ok' as never)).toBeDefined();
    expect(auditSink.snapshot()).toHaveLength(1);
  });

  it('rolls BOTH writes back when fn throws mid-transaction', async () => {
    const repo = new InMemoryApprovalRepository();
    const auditSink = new InMemoryAuditSink();
    const tx = inMemoryTransactionScope(repo, auditSink);
    const req = pendingTestRequest({ requestId: 'req-mtx-rollback' });
    const err = await tx
      .run(async () => {
        await repo.add(req);
        await auditSink.append(
          createAuditEvent({
            type: 'request-resolved',
            occurredAt: clock.now(),
            actor: 'system',
            severity: 'info',
            requestId: req.requestId,
          }),
        );
        throw new Error('disk full');
      })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe('disk full');
    expect(await repo.findById('req-mtx-rollback' as never)).toBeUndefined();
    expect(auditSink.snapshot()).toHaveLength(0);
  });

  it('rollback restores an existing row to its pre-write version (no ghost update)', async () => {
    const repo = new InMemoryApprovalRepository();
    const auditSink = new InMemoryAuditSink();
    const original = pendingTestRequest({ requestId: 'req-mtx-row' });
    await repo.add(original);
    const tx = inMemoryTransactionScope(repo, auditSink);
    await expect(
      tx.run(async () => {
        await repo.compareAndSwap({ ...original, version: 3, state: 'approved' } as never, 2);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const after = await repo.findById('req-mtx-row' as never);
    expect(after?.state).toBe('pending');
    expect(after?.version).toBe(2);
  });

  it('listLive covers pending+created and drops terminal rows (reconciler basis)', async () => {
    const repo = new InMemoryApprovalRepository();
    await repo.add(pendingTestRequest({ requestId: 'req-live-p' }));
    const liveP = await repo.listLive();
    expect(liveP.map((l) => l.requestId)).toContain('req-live-p');
    // a created (not yet pending) row must appear:
    const { createdTestRequest } = await import('@raag/testing');
    await repo.add(createdTestRequest({ requestId: 'req-live-c' }));
    const live = await repo.listLive();
    expect(live.map((l) => l.requestId).sort()).toEqual(['req-live-c', 'req-live-p']);
  });

  it('snapshot/restore keep the store deterministic across reused snapshots', async () => {
    const repo = new InMemoryApprovalRepository();
    await repo.add(pendingTestRequest({ requestId: 'req-snap-1' }));
    const snap = repo.snapshot();
    await repo.add(pendingTestRequest({ requestId: 'req-snap-2' }));
    expect(await repo.findById('req-snap-2' as never)).toBeDefined();
    repo.restore(snap);
    expect(await repo.findById('req-snap-1' as never)).toBeDefined();
    expect(await repo.findById('req-snap-2' as never)).toBeUndefined();
    expect(repo.size()).toBe(1);
  });
});
