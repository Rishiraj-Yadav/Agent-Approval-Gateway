/**
 * The approval state machine — a PURE reducer.
 *
 * No persistence, no Telegram, no agents, no self-owned clocks: every
 * function takes the current request plus a lifecycle event (which carries
 * the core-clock instant) and returns a deterministic result. Ordinary
 * lifecycle races are expressed as typed outcomes (`duplicate | no-change |
 * conflict | rejected`) rather than exceptions, so the application layer can
 * audit the classification without exception plumbing; malformed events
 * themselves throw DomainError at the parsing boundary.
 *
 * Idempotency rules (Phase 2; database-level CAS is a database-phase concern
 * layered on top of `version`):
 *  - a second identical decision on an already-resolved request is a
 *    `duplicate` — the state never changes again;
 *  - a *different* decision on a terminal request is a `conflict` —
 *    reported, terminal state untouched;
 *  - any other late event on a terminal state is `no-change`;
 *  - expired/cancelled/disconnected/failed are deny-equivalent and, like
 *    approved/denied, can never transition back to created/pending.
 */
import { parseDecisionKind, terminalStateForDecision } from './decision.js';
import { DomainError } from './errors.js';
import type { ApprovalRequest } from './request.js';
import { isExpiredAt, type Millis } from './time.js';
import { isTerminalState, type ApprovalState } from './states.js';
import type { DecisionKind, DecisionRecord } from './decision.js';

export type FailureCode = 'persistence-error' | 'audit-failure' | 'delivery-unservable';

export const FAILURE_CODES: readonly FailureCode[] = [
  'persistence-error',
  'audit-failure',
  'delivery-unservable',
];

export function parseFailureCode(raw: unknown, field = 'failureCode'): FailureCode {
  if (typeof raw === 'string' && (FAILURE_CODES as readonly string[]).includes(raw)) {
    return raw as FailureCode;
  }
  throw new DomainError(
    'invalid-state',
    field,
    `failure code must be one of: ${FAILURE_CODES.join(', ')}`,
  );
}

export type LifecycleEvent =
  | { readonly type: 'persisted' }
  | { readonly type: 'decided'; readonly decision: DecisionKind; readonly now: Millis }
  | { readonly type: 'expired'; readonly now: Millis }
  | { readonly type: 'cancelled'; readonly now: Millis }
  | { readonly type: 'agent-disconnected'; readonly now: Millis }
  | { readonly type: 'failed'; readonly code: FailureCode; readonly now: Millis };

export type TransitionRejection =
  | 'cannot-persist-from-non-created'
  | 'cannot-decide-from-non-pending'
  | 'cannot-expire-from-non-pending'
  | 'cannot-cancel-from-non-pending'
  | 'cannot-disconnect-from-non-pending'
  | 'already-expired-at-decision';

export type TransitionResult =
  | { readonly kind: 'advanced'; readonly request: ApprovalRequest }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'no-change' }
  | { readonly kind: 'conflict'; readonly current: DecisionKind }
  | { readonly kind: 'rejected'; readonly reason: TransitionRejection };

export function advance(request: ApprovalRequest, event: LifecycleEvent): TransitionResult {
  const from = request.state;

  if (isTerminalState(from)) {
    if (event.type === 'decided') {
      const decision = parseDecisionKind(event.decision, 'event.decision');
      const current: DecisionRecord | undefined = request.decision;
      if (current === undefined) {
        // expired/cancelled/disconnected/failed: a late decision is a
        // rejected event, never a re-approval (fail closed).
        return { kind: 'rejected', reason: 'cannot-decide-from-non-pending' };
      }
      if (current.kind === decision) {
        return { kind: 'duplicate' };
      }
      return { kind: 'conflict', current: current.kind };
    }
    return { kind: 'no-change' };
  }

  switch (event.type) {
    case 'persisted': {
      if (from !== 'created') {
        return { kind: 'rejected', reason: 'cannot-persist-from-non-created' };
      }
      return step(request, 'pending');
    }
    case 'decided': {
      if (from !== 'pending') {
        return { kind: 'rejected', reason: 'cannot-decide-from-non-pending' };
      }
      const decision = parseDecisionKind(event.decision, 'event.decision');
      // Fail closed: at/after the inclusive expiry boundary the request can
      // never be approved (ADR-019 tie-break).
      if (isExpiredAt(event.now, request.expiresAt)) {
        return { kind: 'rejected', reason: 'already-expired-at-decision' };
      }
      return step(request, terminalStateForDecision(decision), {
        kind: decision,
        decidedAt: event.now,
      });
    }
    case 'expired': {
      if (from !== 'pending') {
        return { kind: 'rejected', reason: 'cannot-expire-from-non-pending' };
      }
      // Repeated/expired-again attempts are deterministic no-ops.
      if (!isExpiredAt(event.now, request.expiresAt)) {
        return { kind: 'no-change' };
      }
      return step(request, 'expired');
    }
    case 'cancelled': {
      if (from !== 'pending') {
        return { kind: 'rejected', reason: 'cannot-cancel-from-non-pending' };
      }
      return step(request, 'cancelled');
    }
    case 'agent-disconnected': {
      if (from !== 'pending') {
        return { kind: 'rejected', reason: 'cannot-disconnect-from-non-pending' };
      }
      return step(request, 'agent-disconnected');
    }
    case 'failed': {
      parseFailureCode(event.code, 'event.code');
      return step(request, 'failed', undefined, event.code);
    }
  }
}

/**
 * Sweep probe: must this pending (or created) request expire right now?
 * Expiry only ever applies to a pending request; created requests expire via
 * their own pending window after transitioning (created never has a live
 * TTL countdown — see ADR-019).
 */
export function shouldExpireAt(request: ApprovalRequest, now: Millis): boolean {
  return request.state === 'pending' && isExpiredAt(now, request.expiresAt);
}

function step(
  request: ApprovalRequest,
  state: ApprovalState,
  decision?: DecisionRecord,
  failureCode?: FailureCode,
): TransitionResult {
  const next = Object.freeze({
    ...request,
    state,
    version: request.version + 1,
    ...(decision === undefined ? {} : { decision }),
    ...(failureCode === undefined ? {} : { failureCode }),
  }) as ApprovalRequest;
  return { kind: 'advanced', request: next };
}
