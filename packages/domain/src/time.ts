/**
 * Time primitives — the domain NEVER calls Date.now(). All "now" values flow
 * in from a `Clock` port (see ports.ts) so expiry logic is deterministic and
 * testable (testing.md rule 2).
 *
 * `Millis` is integer epoch milliseconds, bounded to the ECMAScript Date
 * range and validated at every domain boundary. Durations are a distinct
 * branded type so "120" can never be passed where seconds vs ms is ambiguous.
 */
import { DomainError } from './errors.js';

export type Millis = number & { readonly __brand: 'millis' };
export type DurationMillis = number & { readonly __brand: 'durationMillis' };

/** ±8.64e15 ms — the ECMAScript date range. */
export const MAX_MILLIS = 8_640_000_000_000_000;

/** The specification's mandated default request TTL. */
export const DEFAULT_APPROVAL_TTL_SECONDS = 120;
/** Hard cap: a request may not outlive 1 hour regardless of configuration. */
export const MAX_APPROVAL_TTL_SECONDS = 3_600;
/** Floor: sub-second approvals are meaningless and signal misconfiguration. */
export const MIN_APPROVAL_TTL_SECONDS = 1;

export const TTL_ONE_SECOND: DurationMillis = 1_000 as DurationMillis;

export function secondsToDuration(seconds: number): DurationMillis {
  if (!Number.isInteger(seconds) || seconds < MIN_APPROVAL_TTL_SECONDS) {
    throw new DomainError(
      'invalid-duration',
      'ttlSeconds',
      'ttl must be a whole number of seconds >= ' + MIN_APPROVAL_TTL_SECONDS,
    );
  }
  if (seconds > MAX_APPROVAL_TTL_SECONDS) {
    throw new DomainError(
      'invalid-duration',
      'ttlSeconds',
      `ttl must not exceed ${MAX_APPROVAL_TTL_SECONDS}s (fail closed: cap approvals short)`,
    );
  }
  return (seconds * 1_000) as DurationMillis;
}

export function parseMillis(raw: unknown, field: string): Millis {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new DomainError('invalid-timestamp', field, 'must be an integer epoch-millis value');
  }
  if (raw < 0 || raw > MAX_MILLIS) {
    throw new DomainError('invalid-timestamp', field, 'must be within the ECMAScript date range');
  }
  return raw as Millis;
}

export function millisOf(ms: number): Millis {
  return parseMillis(ms, 'millis');
}

export function addDuration(base: Millis, duration: DurationMillis): Millis {
  const sum = base + duration;
  if (sum > MAX_MILLIS) {
    throw new DomainError('invalid-timestamp', 'expiresAt', 'expiration exceeds the date range');
  }
  return sum as Millis;
}

/**
 * Expiration is inclusive at the boundary: at the exact expiry instant the
 * request is already expired (fail-closed tie-break, ADR-019).
 */
export function isExpiredAt(now: Millis, expiresAt: Millis): boolean {
  return now >= expiresAt;
}
