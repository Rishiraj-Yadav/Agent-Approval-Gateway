import { describe, expect, it } from 'vitest';
import {
  MAX_MILLIS,
  addDuration,
  advance,
  createApprovalRequest,
  createAuditEvent,
  decisionHasSessionScope,
  decisionRequestsStop,
  isExpiredAt,
  millisOf,
  parseApprovalState,
  parseDecisionKind,
  parseFailureCode,
  parseMillis,
  reviveApprovalRequest,
  secondsToDuration,
  type ApprovalRequest,
} from '@raag/domain';

const T0 = millisOf(1_700_000_000_000);
const NOW_LATE = millisOf(1_700_000_005_000); // inside the 120 s default TTL

const base = () => ({
  requestId: 'req-gap',
  correlationId: 'corr-gap',
  agent: { kind: 'kilo', version: '9.9.9' },
  machine: { id: 'm-1' },
  project: { id: 'p-1' },
  session: { sessionId: 's-1' },
  action: {
    tool: 'edit',
    displaySummary: 'touch README.md',
    payloadSha256: 'f'.repeat(64),
    payloadBytes: 3,
  },
  risk: 'low',
  requestedAt: T0,
});

describe('time boundary coverage', () => {
  it('parseMillis rejects non-integers, negatives, out-of-range, non-numbers', () => {
    expect(() => parseMillis(1.5, 'x')).toThrowError(/invalid-timestamp/);
    expect(() => parseMillis(-1, 'x')).toThrowError(/invalid-timestamp/);
    expect(() => parseMillis(MAX_MILLIS + 1, 'x')).toThrowError(/invalid-timestamp/);
    expect(() => parseMillis('now', 'x')).toThrowError(/invalid-timestamp/);
    expect(MAX_MILLIS).toBe(8_640_000_000_000_000);
  });

  it('addDuration overflows fail closed', () => {
    const late = millisOf(MAX_MILLIS - 10);
    expect(() => addDuration(late, secondsToDuration(60))).toThrowError(/invalid-timestamp/);
  });

  it('isExpiredAt boundary inclusive', () => {
    expect(isExpiredAt(millisOf(100), millisOf(100))).toBe(true);
    expect(isExpiredAt(millisOf(99), millisOf(100))).toBe(false);
  });
});

describe('state/decision/failure parse helpers', () => {
  it('parseApprovalState round-trips its union and rejects junk', () => {
    expect(parseApprovalState('pending')).toBe('pending');
    expect(() => parseApprovalState('waiting')).toThrowError(/invalid-state/);
    expect(() => parseApprovalState(7)).toThrowError(/invalid-state/);
  });

  it('parseFailureCode validates enum, parseDecisionKind too', () => {
    expect(parseFailureCode('audit-failure')).toBe('audit-failure');
    expect(() => parseFailureCode('oops')).toThrowError(/invalid-state/);
    expect(() => parseDecisionKind('maybe')).toThrowError(/invalid-decision/);
    expect(decisionHasSessionScope(parseDecisionKind('allow-session'))).toBe(true);
    expect(decisionRequestsStop(parseDecisionKind('deny'))).toBe(false);
  });
});

describe('revive & transition error paths', () => {
  it('revive rejects decisions on live states', () => {
    const req = createApprovalRequest(base());
    expect(() =>
      reviveApprovalRequest(
        {
          ...req,
          state: 'pending',
          decision: { kind: 'deny', decidedAt: millisOf(1) },
        },
        T0,
      ),
    ).toThrowError(/invalid-request/);
  });

  it('revive accepts a proper terminal denied record', () => {
    const req = createApprovalRequest(base());
    const pend = advance(req, { type: 'persisted' });
    if (pend.kind !== 'advanced') throw new Error('fixture failure');
    const fin = advance(pend.request, {
      type: 'decided',
      decision: 'deny',
      now: millisOf(NOW_LATE),
    });
    if (fin.kind !== 'advanced') throw new Error('fixture failure');
    expect(reviveApprovalRequest(fin.request, T0).state).toBe('denied');
  });

  it('failed transitions carry failure code; revive demands it remain present', () => {
    const req = createApprovalRequest(base());
    const pend = advance(req, { type: 'persisted' });
    if (pend.kind !== 'advanced') throw new Error('fixture failure');
    const failed = advance(pend.request, {
      type: 'failed',
      code: 'delivery-unservable',
      now: millisOf(1_700_000_000_001),
    });
    if (failed.kind !== 'advanced') throw new Error('fixture failure');
    expect(failed.request.state).toBe('failed');
    expect(failed.request.failureCode).toBe('delivery-unservable');
    const cloneNoCode: Record<string, unknown> = { ...failed.request };
    delete cloneNoCode['failureCode'];
    expect(() => reviveApprovalRequest(cloneNoCode as unknown as ApprovalRequest, T0)).toThrowError(
      /invalid-request/,
    );
  });
});

describe('audit validation edge branches', () => {
  it('rejects oversized strings, non-finite numbers, and hostile key names', () => {
    expect(() =>
      createAuditEvent({
        type: 'request-created',
        occurredAt: 1,
        actor: 'system',
        detail: { note: 'x'.repeat(300) },
      }),
    ).toThrowError(/invalid-audit-event/);
    expect(() =>
      createAuditEvent({
        type: 'request-created',
        occurredAt: 1,
        actor: 'system',
        detail: { nan: Number.NaN },
      }),
    ).toThrowError(/invalid-audit-event/);
    expect(() =>
      createAuditEvent({
        type: 'request-created',
        occurredAt: 1,
        actor: 'system',
        detail: { 'Bad-Key-Name-Upper': 1 },
      }),
    ).toThrowError(/invalid-audit-event/);
  });
});
