import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * @raag/security — local authentication primitives (ADR-034).
 *
 * The gateway authenticates every inbound frame with HMAC-SHA256 over a
 * canonical string that INCLUDES the timestamp and nonce; plus a bounded
 * replay cache keyed on (ts-window, nonce):
 *  - tampering with any signed field (request/correlation ids, decision,
 *    body) changes the canonical string ⇒ macro fails closed;
 *  - resending a valid frame replays the SAME nonce ⇒ refused within the
 *    window (after the window the nonce would itself be stale ⇒ refused);
 *  - stale or future-dated timestamps outside tolerance ⇒ refused.
 *
 * Secret handling: the key is passed as string, never returned from any
 * function here, never logged; verification compares equal-length digests
 * with `timingSafeEqual` (no oracle on comparison, length mismatches throw
 * through the false path).
 */
/** Acceptable clock-skew window for authenticated frames (± this many ms). */
export const MAX_CLOCK_SKEW_MS = 60_000;

/** Max tracked nonces before FIFO eviction (bounded memory, §28). */
export const REPLAY_CACHE_MAX = 4096;

export function computeMac(key: string, canonical: string): string {
  if (key.length === 0) {
    throw new Error('mac input invalid');
  }
  return createHmac('sha256', key).update(canonical, 'utf8').digest('hex');
}

/** Constant-time comparison; ANY deviation or malformed input → false. */
export function verifyMac(key: string, canonical: string, mac: string): boolean {
  if (typeof mac !== 'string' || !/^[a-f0-9]{64}$/.test(mac)) return false;
  let expected: string;
  try {
    expected = computeMac(key, canonical);
  } catch {
    return false;
  }
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(mac, 'hex');
  if (a.length !== 32 || b.length !== 32) return false;
  return timingSafeEqual(a, b);
}

export interface ReplayDecision {
  readonly ok: boolean;
  readonly reason?: string | undefined;
}

/**
 * Bounded replay-window guard: rejects stale/future timestamps outside
 * ±MAX_CLOCK_SKEW_MS and repeated nonces, evicting oldest entries when the
 * cap is reached (documented FIFO — a replayed nonce that was evicted must
 * ALSO re-fail on timestamp age because max-entries*min-nonce-interval
 * exceeds the skew window only in pathological floods; see ADR-034 note).
 *
 * `now` comes from the core Clock — never an internal Date.now().
 */
export class ReplayGuard {
  #seen = new Set<string>();
  #order: string[] = [];

  constructor(private readonly now: () => number & { readonly __brand: 'millis' }) {}

  check(timestampMs: number, nonce: string): ReplayDecision {
    if (!Number.isInteger(timestampMs) || timestampMs <= 0) {
      return { ok: false, reason: 'stale-timestamp' };
    }
    const drift = Math.abs(this.now() - timestampMs);
    if (drift > MAX_CLOCK_SKEW_MS) {
      return {
        ok: false,
        reason: timestampMs > this.now() ? 'future-timestamp' : 'stale-timestamp',
      };
    }
    if (this.#seen.has(nonce)) {
      return { ok: false, reason: 'replayed-nonce' };
    }
    // Accepted: record AFTER auth succeeded at frame level (caller verified
    // mac first — this guard records, it does not authenticate).
    this.#seen.add(nonce);
    this.#order.push(nonce);
    if (this.#order.length > REPLAY_CACHE_MAX) {
      const oldest = this.#order[0];
      if (oldest !== undefined) {
        this.#order.shift();
        this.#seen.delete(oldest);
      }
    }
    return { ok: true };
  }

  get size(): number {
    return this.#seen.size;
  }
}
