import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createAuditEvent } from '@raag/domain';
import { openSqliteStore } from '@raag/database';
import { createFakeClock, createdTestRequest, pendingTestRequest } from '@raag/testing';

function tmpPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'raag-db-'));
  return join(dir, name);
}

function clock() {
  return createFakeClock(1_700_000_000_000);
}

describe('schema / pragmas / fail-closed opens (ADR-031/032)', () => {
  it('opens the durability posture: WAL + FULL + FKs + busy + schema 1', () => {
    const store = openSqliteStore({ path: tmpPath('pg.db'), clock: clock() });
    const p = store.pragmas();
    expect(p.journalMode).toBe('wal');
    expect(p.synchronous).toBe(2);
    expect(p.foreignKeys).toBe(1);
    expect(p.busyTimeoutMs).toBeGreaterThanOrEqual(5_000);
    expect(p.userVersion).toBe(1);
    store.close();
  });

  it('reopening is a no-op migration-wise and preserves data + audit', async () => {
    const path = tmpPath('reopen.db');
    const one = openSqliteStore({ path, clock: clock() });
    const req = pendingTestRequest({ requestId: 'req-open-1' });
    expect(await one.repository.add(req)).toBe('stored');
    await one.audit.append(
      createAuditEvent({
        type: 'request-created',
        occurredAt: 1_700_000_000_000,
        actor: 'manager',
        severity: 'info',
        requestId: req.requestId,
        correlationId: req.correlationId,
        detail: { tool: req.action.tool },
      }),
    );
    one.close();

    const two = openSqliteStore({ path, clock: clock() });
    expect(two.pragmas().userVersion).toBe(1);
    const found = await two.repository.findById('req-open-1' as never);
    expect(found?.state).toBe('pending');
    expect(two.audit.forRequest('req-open-1')).toHaveLength(1);
    two.close();
  });

  it('a FUTURE schema refuses to open (never destructive-downgrades)', () => {
    const path = tmpPath('future.db');
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 99;');
    raw.close();
    expect(() => openSqliteStore({ path, clock: clock() })).toThrowError(/newer|version/i);
  });

  it('a corrupt ledger fails the integrity probe', () => {
    const path = tmpPath('corrupt.db');
    writeFileSync(path, Buffer.from('garbage bytes 0123456789 not a sqlite file at all'));
    expect(() => openSqliteStore({ path, clock: clock() })).toThrowError();
  });

  it('a row tampered OUTSIDE the app cannot hydrate into a trusted request', async () => {
    const path = tmpPath('tampered.db');
    const store = openSqliteStore({ path, clock: clock() });
    const req = pendingTestRequest({ requestId: 'req-tamper-1' });
    await store.repository.add(req);
    store.close();
    const raw = new DatabaseSync(path);
    // an empty machine id passes every table CHECK but cannot hydrate past
    // the domain's opaque-ID validator:
    raw
      .prepare('UPDATE approval_requests SET machine_id = ? WHERE request_id = ?')
      .run('', 'req-tamper-1');
    raw.close();
    const again = openSqliteStore({ path, clock: clock() });
    await expect(again.repository.findById('req-tamper-1' as never)).rejects.toThrowError();
    again.close();
  });
});

describe('CAS + transactional semantics (spec §9/§11 gates)', () => {
  it('add rejects duplicates with the port outcome', async () => {
    const store = openSqliteStore({ path: ':memory:', clock: clock() });
    const a = pendingTestRequest({ requestId: 'req-cas-dup' });
    expect(await store.repository.add(a)).toBe('stored');
    expect(await store.repository.add(a)).toBe('duplicate-request-id');
    store.close();
  });

  it('two racing CAS attempts: exactly one updates, the other conflicts', async () => {
    const store = openSqliteStore({ path: ':memory:', clock: clock() });
    const created = createdTestRequest({ requestId: 'req-race' });
    await store.repository.add(created);
    const approve = { ...created, state: 'pending' as const, version: 2 };
    const other = { ...created, state: 'created' as const, version: 2 };
    const results = await Promise.all([
      store.repository.compareAndSwap(approve as never, 1),
      store.repository.compareAndSwap(other as never, 1),
    ]);
    const updated = results.filter((r) => r === 'updated');
    expect(updated).toHaveLength(1);
    const after = await store.repository.findById('req-race' as never);
    expect(after?.state).toBe(results[0] === 'updated' ? 'pending' : 'created');
    // third attempt on a now-bumped revision: everyone loses
    expect(await store.repository.compareAndSwap(approve as never, 1)).toBe('version-conflict');
    store.close();
  });

  it('immutable scope pinning rejects reshaping even with the right revision', async () => {
    const store = openSqliteStore({ path: ':memory:', clock: clock() });
    const req = createdTestRequest({ requestId: 'req-imm' });
    await store.repository.add(req);
    // Legal-looking revision, but mutates an immutable scope column → the
    // pinned WHERE must miss the row.
    const tamperedSession = {
      ...req,
      session: { sessionId: 'sess-999' },
      version: 2,
      state: 'pending',
    } as never;
    const tamperedTimer = {
      ...req,
      expiresAt: req.expiresAt + 60_000,
      version: 2,
      state: 'pending',
    } as never;
    expect(await store.repository.compareAndSwap(tamperedSession, 1)).toBe('version-conflict');
    expect(await store.repository.compareAndSwap(tamperedTimer, 1)).toBe('version-conflict');
    expect((await store.repository.findById('req-imm' as never))?.state).toBe('created');
    store.close();
  });

  it('missing request CAS reports missing (no phantom, no silent insert), never approves', async () => {
    const store = openSqliteStore({ path: ':memory:', clock: clock() });
    const req = {
      ...createdTestRequest({ requestId: 'req-nope-999' }),
      version: 2,
      state: 'pending',
    } as never;
    expect(await store.repository.compareAndSwap(req, 1)).toBe('missing');
    expect(await store.repository.findById('req-nope-999' as never)).toBeUndefined();
    // expectedVersion 0 would INSERT — reserved for the port's add() contract:
    const zero = { ...createdTestRequest({ requestId: 'req-zero-insert' }), version: 1 } as never;
    expect(await store.repository.compareAndSwap(zero, 0)).toBe('updated');
    expect(await store.repository.findById('req-zero-insert' as never)).toBeDefined();
    store.close();
  });

  it('transactionScope.commit is atomic; a throw mid-transaction leaves nothing (no partially applied approval)', async () => {
    const store = openSqliteStore({ path: ':memory:', clock: clock() });
    const req = pendingTestRequest({ requestId: 'req-txn-rollback' });
    const event = createAuditEvent({
      type: 'request-created',
      occurredAt: 1_700_000_000_000,
      actor: 'manager',
      severity: 'info',
      requestId: req.requestId,
      correlationId: req.correlationId,
    });
    await expect(
      store.transactionScope.run(async () => {
        await store.repository.add(req);
        await store.audit.append(event);
        throw new Error('simulated audit disk failure');
      }),
    ).rejects.toThrowError('simulated audit disk failure');
    expect(await store.repository.findById('req-txn-rollback' as never)).toBeUndefined();
    expect(store.audit.count()).toBe(0);
    store.close();
  });

  it('transactionScope commits both writes together', async () => {
    const store = openSqliteStore({ path: ':memory:', clock: clock() });
    const req = pendingTestRequest({ requestId: 'req-txn-commit' });
    const event = createAuditEvent({
      type: 'request-resolved',
      occurredAt: 1_700_000_000_000,
      actor: 'manager',
      severity: 'info',
      requestId: req.requestId,
      correlationId: req.correlationId,
      detail: { decision: 'allow-once' },
    });
    await store.transactionScope.run(async () => {
      await store.repository.add(req);
      await store.audit.append(event);
    });
    expect(await store.repository.findById('req-txn-commit' as never)).toBeDefined();
    expect(store.audit.count()).toBe(1);
    store.close();
  });

  it('closed store fails every op (no zombie reads)', async () => {
    const store = openSqliteStore({ path: ':memory:', clock: clock() });
    store.close();
    await expect(store.repository.findById('x' as never)).rejects.toThrowError();
  });
});
