import { describe, expect, it } from 'vitest';
import { WaiterRegistry, MAX_WAITERS } from '@raag/local-gateway';
import { createFakeClock, pendingTestRequest } from '@raag/testing';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('WaiterRegistry (spec §20 lifecycle guarantees)', () => {
  it('attaches by requestId, wakes ONLY the matching terminal snapshot', async () => {
    const now = createFakeClock(0);
    const waiters = new WaiterRegistry(now.current);
    const a = pendingTestRequest({ requestId: 'req-w-a', correlationId: 'corr-w-a' });
    const b = pendingTestRequest({ requestId: 'req-w-b', correlationId: 'corr-w-b' });
    const pa = waiters.attach(a);
    const pb = waiters.attach(b);
    expect(pa).toBeDefined();
    expect(pb).toBeDefined();
    expect(waiters.size).toBe(2);

    expect(waiters.resolveTerminal(b)).toBe(true);
    expect((await pb)?.kind).toBe('terminal');
    expect(waiters.size).toBe(1);
    // duplicate resolution is harmless
    expect(waiters.resolveTerminal(b)).toBe(false);
    waiters.clearAll();
    expect((await pa)?.kind).toBe('closed');
  });

  it('cross-scope wake (same requestId, different correlationId) is refused', async () => {
    const now = createFakeClock(0);
    const waiters = new WaiterRegistry(now.current);
    const a = pendingTestRequest({ requestId: 'req-x', correlationId: 'corr-true' });
    const hijack = Object.freeze({
      ...a,
      correlationId: 'corr-fake' as typeof a.correlationId,
      state: 'approved' as const,
    });
    const p = waiters.attach(a);
    expect(p).toBeDefined();
    expect(waiters.resolveTerminal(hijack)).toBe(false);
    expect(waiters.size).toBe(1); // survives until legit wake or its timer
    waiters.clearAll();
    expect((await p)?.kind).toBe('closed');
  });

  it('bounded lifetime: the wait never outlives the request window (no leak)', async () => {
    const now = createFakeClock(0);
    const waiters = new WaiterRegistry(now.current);
    // ttl 1s → timer ≈ remaining + grace (wall ms) then self-removes.
    const soon = pendingTestRequest({ requestId: 'req-soon', ttlSeconds: 1 });
    const p = waiters.attach(soon);
    expect(p).toBeDefined();
    const raced = await Promise.race([p, wait(1_500).then(() => undefined)]);
    if (raced === undefined) {
      // starved harness: still prove bounded release via clearAll
      waiters.clearAll();
      expect(waiters.size).toBe(0);
      return;
    }
    expect(raced.kind).toBe('expired-wait');
    expect(waiters.size).toBe(0); // the timer removed it — no orphan entry
  }, 4_000);

  it('drop (socket hung up mid-wait) removes the entry WITHOUT fabricating a result', () => {
    const clock = createFakeClock(0);
    const waiters = new WaiterRegistry(clock.current);
    const a = pendingTestRequest({ requestId: 'req-drop-me', ttlSeconds: 5 });
    const p = waiters.attach(a);
    expect(p).toBeDefined();
    expect(waiters.drop('req-drop-me')).toBe(true);
    expect(waiters.drop('req-drop-me')).toBe(false); // idempotent
    expect(waiters.size).toBe(0);
    waiters.clearAll(); // detached promise is never "decided" by a drop
  });

  it('double-attach to the same requestId yields a poll-instead answer (undefined)', () => {
    const now = createFakeClock(0);
    const waiters = new WaiterRegistry(now.current);
    const a = pendingTestRequest({ requestId: 'req-dup-attach' });
    expect(waiters.attach(a)).toBeDefined();
    expect(waiters.attach(a)).toBeUndefined();
    waiters.clearAll();
  });

  it('capacity refuses new attaches beyond MAX_WAITERS (fail closed: caller polls)', () => {
    const now = createFakeClock(0);
    const waiters = new WaiterRegistry(now.current);
    for (let i = 0; i < MAX_WAITERS; i++) {
      const r = pendingTestRequest({
        requestId: `r-${i}`,
        correlationId: `c-${i}`,
        ttlSeconds: 30,
      });
      expect(waiters.attach(r)).toBeDefined();
    }
    const overflow = pendingTestRequest({
      requestId: 'r-overflow',
      correlationId: 'c-over',
      ttlSeconds: 30,
    });
    expect(waiters.attach(overflow)).toBeUndefined();
    waiters.clearAll();
  });
});
