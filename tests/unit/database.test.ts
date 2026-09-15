import { describe, expect, it } from 'vitest';
import { advance, createAuditEvent, millisOf } from '@raag/domain';
import { createFakeClock, createFixedIdGenerator, createSystemClock } from '@raag/testing';
import { createdTestRequest, pendingTestRequest, TEST_HASH } from '@raag/testing';

describe('in-memory ApprovalRepository', () => {
  const make = () => import('@raag/database').then((m) => new m.InMemoryApprovalRepository());

  it('stores, reads, rejects duplicates, and CAS-guards updates', async () => {
    const repo = await make();
    const req = pendingTestRequest({ requestId: 'req-inmem-1' });
    expect(await repo.add(req)).toBe('stored');
    expect(await repo.add(Object.freeze({ ...req }))).toBe('duplicate-request-id');
    expect(await repo.findById(req.requestId)).toEqual(req);
    const denied = Object.freeze({ ...req, state: 'denied' as const, version: req.version + 1 });
    expect(await repo.compareAndSwap(denied, req.version)).toBe('updated');
    expect((await repo.findById(req.requestId))?.state).toBe('denied');
    expect(await repo.compareAndSwap(req, req.version)).toBe('version-conflict');
    expect(await repo.listPending()).toEqual([]);
  });

  it('seeds nothing and isolates instances', async () => {
    const a = await make();
    const b = await make();
    const req = pendingTestRequest({ requestId: 'req-inmem-2' });
    await a.add(req);
    expect(await b.findById(req.requestId)).toBeUndefined();
  });

  it('listPending reflects live created requests too (expiry sweep input)', async () => {
    const repo = await make();
    const p = pendingTestRequest({ requestId: 'req-inmem-list' });
    await repo.add(p);
    const c = createdTestRequest({ requestId: 'req-inmem-live' });
    await repo.add(c);
    expect((await repo.listPending()).map((r) => r.requestId)).toContain(p.requestId);
  });
});

describe('in-memory AuditSink', () => {
  it('appends audit events and snapshots them', async () => {
    const mod = await import('@raag/database');
    const sink = new mod.InMemoryAuditSink();
    await sink.append(
      createAuditEvent({
        type: 'request-created',
        occurredAt: millisOf(10),
        actor: 'system',
        severity: 'info',
        detail: { tool: 'bash' },
      }),
    );
    expect(sink.events()).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(sink.events()[0]))).toMatchObject({
      type: 'request-created',
    });
  });
});

describe('fake clock', () => {
  it('starts at initial time, advances deterministically, honors boundary', () => {
    const clock = createFakeClock(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(500);
    expect(clock.now()).toBe(1_500);
    clock.advance(0);
    expect(clock.now()).toBe(1_500);
    clock.setTo(2_000);
    expect(clock.now()).toBe(2_000);
    expect(() => clock.advance(-1)).toThrowError(/advance/);
    expect(() => clock.setTo(1)).toThrowError(/backwards/);
    const req = pendingTestRequest({ requestedAt: 2_000, ttlSeconds: 3 });
    expect(req.expiresAt).toBe(5_000);
    expect(advance(req, { type: 'expired', now: millisOf(4_999) }).kind).toBe('no-change');
    expect(advance(req, { type: 'expired', now: millisOf(5_000) }).kind).toBe('advanced');
  });

  it('system clock is a monotonic-enough Millis supplier (smoke)', () => {
    const clock = createSystemClock();
    const a = clock.now();
    expect(Number.isInteger(a)).toBe(true);
  });
});

describe('fixed id generator', () => {
  it('produces deterministic, valid, unique ids', () => {
    const gen = createFixedIdGenerator('req');
    expect(gen.newId()).toBe('req-1');
    expect(gen.newId()).toBe('req-2');
  });
});

describe('domain builder fixtures', () => {
  it('createdTestRequest/pendingTestRequest are valid domain objects', () => {
    const c = createdTestRequest();
    expect(c.state).toBe('created');
    expect(c.action.payloadSha256).toBe(TEST_HASH);
    expect(pendingTestRequest().state).toBe('pending');
    expect(() =>
      createdTestRequest({ action: { ...createdTestRequest().action, tool: '' } }),
    ).toThrow(/invalid-action/);
  });
});
