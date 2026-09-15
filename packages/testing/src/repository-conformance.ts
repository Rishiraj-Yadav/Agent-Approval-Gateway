import { describe, expect, it } from 'vitest';
import type { ApprovalRepository, ApprovalRequest } from '@raag/domain';
import { parseCorrelationId } from '@raag/domain';
import { createdTestRequest, pendingTestRequest } from './harness.js';

function stepToCancelled(req: ApprovalRequest): ApprovalRequest {
  return Object.freeze({
    ...req,
    state: 'cancelled' as const,
    version: req.version + 1,
  });
}

/**
 * Repository conformance contract (ADR-010): the behavioral invariants every
 * ApprovalRepository implementation must satisfy — in-memory now, SQLite
 * later — so the two can never drift apart.
 */
export function runRepositoryConformance(make: () => ApprovalRepository): void {
  describe('ApprovalRepository conformance', () => {
    it('add -> findById returns the identical stored request', async () => {
      const repo = make();
      const req = pendingTestRequest();
      expect(await repo.add(req)).toBe('stored');
      expect(await repo.findById(req.requestId)).toEqual(req);
    });

    it('duplicate request id is reported, never silently overwritten', async () => {
      const repo = make();
      const req = pendingTestRequest({ requestId: 'req-conformance-dup' });
      expect(await repo.add(req)).toBe('stored');
      expect(await repo.add(req)).toBe('duplicate-request-id');
      expect(await repo.findById(req.requestId)).toEqual(req);
    });

    it('missing request: findById undefined, CAS reports missing', async () => {
      const repo = make();
      const req = pendingTestRequest({ requestId: 'req-conformance-missing' });
      expect(await repo.findById(req.requestId)).toBeUndefined();
      expect(await repo.compareAndSwap(req, 1)).toBe('missing');
    });

    it('CAS succeeds only against the expected version', async () => {
      const repo = make();
      const created = pendingTestRequest({ requestId: 'req-conformance-cas' });
      await repo.add(created);
      const v = created.version;
      expect(await repo.compareAndSwap(created, v - 1)).toBe('version-conflict');
      // Proper bump (what the state machine produces): same scope, version+1.
      const bumped = stepToCancelled(created);
      expect(await repo.compareAndSwap(bumped, v)).toBe('updated');
      expect((await repo.findById(created.requestId))?.state).toBe('cancelled');
      // stale retry cannot revive/reshape
      expect(await repo.compareAndSwap(created, v)).toBe('version-conflict');
    });

    it('CAS rejects scope/timer reshaping (identity fields are immutable)', async () => {
      const repo = make();
      const created = pendingTestRequest({ requestId: 'req-conformance-immutable' });
      await repo.add(created);
      const reshaped = Object.freeze({
        ...created,
        version: created.version + 1,
        correlationId: parseCorrelationId('corr-something-else-1'),
      });
      const outcome = await repo.compareAndSwap(reshaped, created.version);
      expect(outcome).toBe('version-conflict');
    });

    it('listPending covers only pending state', async () => {
      const repo = make();
      const a = pendingTestRequest({ requestId: 'req-conformance-list-a' });
      await repo.add(a);
      await repo.add(pendingTestRequest({ requestId: 'req-conformance-list-b' }));
      const settled = stepToCancelled(a);
      await repo.compareAndSwap(settled, a.version);
      const pending = await repo.listPending();
      expect(pending.map((r) => r.requestId)).not.toContain(a.requestId);
      expect(pending.length).toBe(1);
    });

    it('listLive is a superset of listPending and excludes terminals (reconciler basis)', async () => {
      const repo = make();
      const pendingOne = pendingTestRequest({ requestId: 'req-conformance-live-p' });
      const createdOne = createdTestRequest({ requestId: 'req-conformance-live-c' });
      await repo.add(pendingOne);
      await repo.add(createdOne);
      const live = await repo.listLive();
      const liveIds = live.map((r) => r.requestId);
      expect(liveIds).toContain(pendingOne.requestId);
      expect(liveIds).toContain(createdOne.requestId);
      const pending = await repo.listPending();
      for (const p of pending) expect(liveIds).toContain(p.requestId);
      await repo.compareAndSwap(stepToCancelled(createdOne), createdOne.version);
      const liveAfter = (await repo.listLive()).map((r) => r.requestId);
      expect(liveAfter).not.toContain(createdOne.requestId);
    });

    it('instances are isolated (per-fresh-repo determinism)', async () => {
      const req = pendingTestRequest({ requestId: 'req-conformance-isolated' });
      const one = make();
      await one.add(req);
      const two = make();
      expect(await two.findById(req.requestId)).toBeUndefined();
    });
  });
}
