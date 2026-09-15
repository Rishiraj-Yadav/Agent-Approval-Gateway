import { describe, expect, it } from 'vitest';
import {
  advance,
  createApprovalRequest,
  isExpiredAt,
  parseMillis,
  shouldExpireAt,
  terminalStateForDecision,
  DECISION_KINDS,
  APPROVAL_STATES,
  isTerminalState,
  type ApprovalRequest,
  type DecisionKind,
  type LifecycleEvent,
  type Millis,
} from '@raag/domain';

const T0 = parseMillis(1_700_000_000_000, 't0');
const S = 1_000;

function pending(ttlSeconds = 120): ApprovalRequest {
  const created = createApprovalRequest({
    requestId: 'req-fixed-001',
    correlationId: 'corr-fixed-001',
    agent: { kind: 'claude-code', version: '1.2.3' },
    machine: { id: 'mach-1', displayName: 'workstation' },
    project: { id: 'proj-1', displayPath: 'C:\\dev\\app' },
    session: { sessionId: 'sess-1' },
    action: {
      tool: 'bash',
      displaySummary: 'run: npm test',
      payloadSha256: 'a'.repeat(64),
      payloadBytes: 42,
    },
    risk: 'medium',
    requestedAt: T0,
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
  });
  const r = advance(created, { type: 'persisted' });
  if (r.kind !== 'advanced') throw new Error('fixture failed');
  return r.request;
}

const decided = (now: Millis, decision: DecisionKind): LifecycleEvent => ({
  type: 'decided',
  now,
  decision,
});

describe('lifecycle basics', () => {
  it('creation yields state=created version=1; persisted -> pending v2', () => {
    expect(terminalStateForDecision('deny')).toBe('denied');
    const created = createApprovalRequest({
      requestId: 'req-1',
      correlationId: 'corr-1',
      agent: { kind: 'codex', version: '0.9' },
      machine: { id: 'mach-1' },
      project: { id: 'proj-1' },
      session: { sessionId: 'sess-1' },
      action: {
        tool: 'edit_file',
        displaySummary: 'edit src/x.ts',
        payloadSha256: 'b'.repeat(64),
        payloadBytes: 2_048,
      },
      risk: 'low',
      requestedAt: T0,
    });
    expect(created.state).toBe('created');
    expect(created.version).toBe(1);
    expect(created.expiresAt).toBe(T0 + 120 * S); // spec default TTL
    const outcome = advance(created, { type: 'persisted' });
    expect(outcome.kind).toBe('advanced');
    if (outcome.kind !== 'advanced') return;
    expect(outcome.request.state).toBe('pending');
    expect(outcome.request.version).toBe(2);
  });

  it('persisted twice rejects the second (no created->pending loop)', () => {
    const p = pending();
    expect(advance(p, { type: 'persisted' })).toEqual({
      kind: 'rejected',
      reason: 'cannot-persist-from-non-created',
    });
  });
});

describe('expiration', () => {
  it('boundary: expiresAt-1 not expired; exactly expiresAt IS expired (inclusive)', () => {
    const p = pending();
    expect(isExpiredAt((T0 + 119_999) as Millis, p.expiresAt)).toBe(false);
    expect(isExpiredAt(p.expiresAt, p.expiresAt)).toBe(true);
  });

  it('decision before expiry advances', () => {
    const p = pending();
    const r = advance(p, decided((p.expiresAt - 1) as Millis, 'allow-once'));
    expect(r.kind).toBe('advanced');
    if (r.kind === 'advanced') {
      expect(r.request.state).toBe('approved');
      expect(r.request.decision?.kind).toBe('allow-once');
    }
  });

  it('decision exactly AT expiry fails closed (reject, never approved)', () => {
    const p = pending();
    expect(advance(p, decided(p.expiresAt, 'allow-once'))).toEqual({
      kind: 'rejected',
      reason: 'already-expired-at-decision',
    });
    expect(advance(p, decided((p.expiresAt + 5_000) as Millis, 'allow-once'))).toEqual({
      kind: 'rejected',
      reason: 'already-expired-at-decision',
    });
  });

  it('expiry sweep: pre-expiry no-change, at-boundary advances to expired', () => {
    const p = pending();
    expect(advance(p, { type: 'expired', now: (p.expiresAt - 1) as Millis })).toEqual({
      kind: 'no-change',
    });
    const r = advance(p, { type: 'expired', now: p.expiresAt });
    expect(r.kind).toBe('advanced');
    if (r.kind === 'advanced') expect(r.request.state).toBe('expired');
  });

  it('repeated expiration is deterministic and never approves', () => {
    const p = pending();
    const at = { type: 'expired' as const, now: p.expiresAt };
    const first = advance(p, at);
    const again = first.kind === 'advanced' ? advance(first.request, at) : first;
    expect(again.kind).toBe('no-change'); // now terminal
  });

  it('created requests are swept via failed only; expiry needs pending', () => {
    const created = createApprovalRequest({
      requestId: 'req-1',
      correlationId: 'corr-1',
      agent: { kind: 'kilo', version: '4' },
      machine: { id: 'mach-1' },
      project: { id: 'proj-1' },
      session: { sessionId: 'sess-1' },
      action: {
        tool: 'bash',
        displaySummary: 'x',
        payloadSha256: 'c'.repeat(64),
        payloadBytes: 1,
      },
      risk: 'high',
      requestedAt: T0,
    });
    expect(advance(created, { type: 'expired', now: (T0 + 999 * S) as Millis })).toEqual({
      kind: 'rejected',
      reason: 'cannot-expire-from-non-pending',
    });
  });

  it('shouldExpireAt probes pending expiry inclusively, never on terminal', () => {
    const p = pending();
    expect(shouldExpireAt(p, (p.expiresAt - 1) as Millis)).toBe(false);
    expect(shouldExpireAt(p, p.expiresAt)).toBe(true);
    const approved = advance(p, decided((p.expiresAt - 1) as Millis, 'allow-once'));
    if (approved.kind !== 'advanced') throw new Error('fixture failure');
    expect(shouldExpireAt(approved.request, p.expiresAt)).toBe(false);
  });
});

describe('idempotency and concurrency foundations', () => {
  it('approve once, then identical approve again: no further transition', () => {
    const p = pending();
    const first = advance(p, decided((T0 + 10 * S) as Millis, 'allow-once'));
    if (first.kind !== 'advanced') throw new Error('fixture failure');
    expect(advance(first.request, decided((T0 + 11 * S) as Millis, 'allow-once'))).toEqual({
      kind: 'duplicate',
    });
  });

  it('deny after approved / approve after denied: conflict, state frozen', () => {
    const p = pending();
    const approved = advance(p, decided((T0 + 5 * S) as Millis, 'allow-once'));
    if (approved.kind !== 'advanced') throw new Error('fixture failure');
    expect(advance(approved.request, decided((T0 + 6 * S) as Millis, 'deny'))).toEqual({
      kind: 'conflict',
      current: 'allow-once',
    });

    const denied = advance(p, decided((T0 + 5 * S) as Millis, 'deny'));
    if (denied.kind !== 'advanced') throw new Error('fixture failure');
    for (const allow of ['allow-once', 'allow-session'] as const) {
      expect(advance(denied.request, decided((T0 + 6 * S) as Millis, allow))).toEqual({
        kind: 'conflict',
        current: 'deny',
      });
    }
  });

  it('stop-agent on denied duplicates as deny-class terminal only', () => {
    const p = pending();
    const stopped = advance(p, decided((T0 + 2 * S) as Millis, 'stop-agent'));
    if (stopped.kind !== 'advanced') throw new Error('fixture failure');
    expect(stopped.request.state).toBe('denied');
    expect(advance(stopped.request, decided((T0 + 3 * S) as Millis, 'stop-agent'))).toEqual({
      kind: 'duplicate',
    });
    expect(advance(stopped.request, decided((T0 + 4 * S) as Millis, 'deny'))).toEqual({
      kind: 'conflict',
      current: 'stop-agent',
    });
  });

  it('multiple concurrent identical decisions are one event', () => {
    const p = pending();
    const results = [10, 11, 12].map((t) => advance(p, decided((T0 + t * S) as Millis, 'deny')));
    expect(results[0]?.kind).toBe('advanced');
    const settled = results[0]?.kind === 'advanced' ? results[0].request : p;
    expect(advance(settled, decided((T0 + 30 * S) as Millis, 'deny'))).toEqual({
      kind: 'duplicate',
    });
  });

  it('version increases exactly once per advanced transition', () => {
    const p = pending();
    const r = advance(p, decided((T0 + 1 * S) as Millis, 'allow-session'));
    if (r.kind !== 'advanced') throw new Error('fixture failure');
    expect(r.request.version).toBe(3); // v1 created, v2 pending, v3 terminal
    expect(p.version).toBe(2); // untouched — frozen input
    expect(Object.isFrozen(r.request)).toBe(true);
  });
});

describe('exhaustive safety', () => {
  const eventsFor = (): LifecycleEvent[] => [
    { type: 'persisted' },
    ...DECISION_KINDS.map((d) => decided((T0 + 10 * S) as Millis, d)),
    { type: 'expired', now: (T0 + 86_400 * S) as Millis },
    { type: 'cancelled', now: (T0 + 5 * S) as Millis },
    { type: 'agent-disconnected', now: (T0 + 5 * S) as Millis },
    { type: 'failed', code: 'persistence-error', now: (T0 + 5 * S) as Millis },
  ];

  it('no terminal state ever becomes live again for ANY event sequence', () => {
    const p = pending();
    for (const e of eventsFor()) {
      const first = advance(p, e);
      if (first.kind !== 'advanced') continue;
      let current: ApprovalRequest | undefined;
      if (first.kind === 'advanced') current = first.request;
      if (!current) continue;
      for (const e2 of eventsFor()) {
        const second = advance(current, e2);
        if (second.kind === 'advanced') {
          for (const st of APPROVAL_STATES) {
            if (second.request.state === st && !isTerminalState(st)) {
              expect(`revive ${st} via ${e2.type}`).toBeUndefined();
            }
          }
        }
      }
    }
  });

  it('expired is deny-equivalent terminal for all follow-up decisions', () => {
    const p = pending();
    const e = advance(p, { type: 'expired', now: (p.expiresAt + 1) as Millis });
    if (e.kind !== 'advanced') throw new Error('fixture failure');
    for (const d of DECISION_KINDS) {
      expect(advance(e.request, decided(p.expiresAt, d)).kind).toBe('rejected');
    }
  });
});
