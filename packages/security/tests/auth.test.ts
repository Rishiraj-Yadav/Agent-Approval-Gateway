import { describe, expect, it } from 'vitest';
import {
  MAX_CLOCK_SKEW_MS,
  REPLAY_CACHE_MAX,
  ReplayGuard,
  computeMac,
  verifyMac,
} from '@raag/security';
import { createFakeClock } from '@raag/testing';

const KEY = 'test-mac-key-0123456789abcdefABCDEF0';

describe('mac compute/verify', () => {
  it('round-trips and is hex-64', () => {
    const mac = computeMac(KEY, 'payload');
    expect(mac).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyMac(KEY, 'payload', mac)).toBe(true);
  });

  it('rejects wrong key, wrong input, wrong mac, short/garbage mac', () => {
    const mac = computeMac(KEY, 'payload');
    expect(verifyMac('a-different-key', 'payload', mac)).toBe(false);
    const mac2 = computeMac(KEY, 'payload');
    expect(verifyMac(KEY, 'PAYLOAD', mac2)).toBe(false);
    // flip a hex digit (guarantees a different mac — naive slicing flakes 1/16):
    const flipped = (mac2[0] === '0' ? '1' : '0') + mac2.slice(1);
    expect(verifyMac(KEY, 'payload', flipped)).toBe(false);
    expect(verifyMac(KEY, 'payload', 'short')).toBe(false);
    expect(verifyMac(KEY, 'payload', 'g'.repeat(64))).toBe(false); // non-hex never passes
  });

  it('empty key refuses to sign (never emit a default-secret MAC)', () => {
    expect(() => computeMac('', 'payload')).toThrowError();
    expect(verifyMac('', 'payload', '0'.repeat(64))).toBe(false);
  });

  it('different nonces change the MAC over the same message', () => {
    const a = computeMac(KEY, 'raag.local|1|n1|{"k":1}');
    const b = computeMac(KEY, 'raag.local|1|n2|{"k":1}');
    expect(a).not.toBe(b);
  });
});

describe('ReplayGuard (freshness + nonce reuse)', () => {
  it('accepts fresh timestamps inside the skew window', () => {
    const clock = createFakeClock(1_000_000);
    const guard = new ReplayGuard(clock.current);
    expect(guard.check(clock.now(), 'nonce-1').ok).toBe(true);
  });

  it('rejects stale and future timestamps, never approving the nonce', () => {
    const clock = createFakeClock(100_000);
    const guard = new ReplayGuard(clock.current);
    const stale = guard.check(100_000 - MAX_CLOCK_SKEW_MS - 10, 'n-a');
    expect(stale.ok).toBe(false);
    const future = guard.check(100_000 + MAX_CLOCK_SKEW_MS + 10, 'n-b');
    expect(future.ok).toBe(false);
    expect(stale.reason ?? '').toBe('stale-timestamp');
    expect(future.reason ?? '').toBe('future-timestamp');
    // boundary INSIDE accepted once each:
    expect(guard.check(100_000, 'at-now').ok).toBe(true);
    expect(guard.check(100_000 + MAX_CLOCK_SKEW_MS, 'edge-future').ok).toBe(true);
    expect(guard.check(100_000, 'at-now').ok).toBe(false);
  });

  it('nonce reuse is refused (replay), second nonce accepted', () => {
    const clock = createFakeClock(1);
    const guard = new ReplayGuard(clock.current);
    expect(guard.check(1, 'dup').ok).toBe(true);
    expect(guard.check(1, 'dup').ok).toBe(false);
    const second = guard.check(1, 'dup');
    expect(second.reason ?? '').toBe('replayed-nonce');
  });

  it('bounded memory: evicts the oldest nonce beyond REPLAY_CACHE_MAX', () => {
    const clock = createFakeClock(10);
    const guard = new ReplayGuard(clock.current);
    for (let i = 0; i < REPLAY_CACHE_MAX; i++) {
      expect(guard.check(10, `nonce-${i}`).ok).toBe(true);
    }
    // one more evicts nonce-0
    expect(guard.check(10, 'overflow-ok').ok).toBe(true);
    // nonce-0 was evicted — replay of the *evicted* nonce is now allowed again
    // ONLY because it aged out of cache; document this trade-off in ADR-034;
    // re-use of any recently-seen nonce still fails:
    expect(guard.check(10, 'overflow-ok').ok).toBe(false);
    expect(guard.size).toBeLessThanOrEqual(REPLAY_CACHE_MAX);
  });
});
