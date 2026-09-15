import {
  advance,
  createApprovalRequest,
  millisOf,
  type ApprovalRequest,
  type AuditEvent,
  type AuditSink,
  type Clock,
  type IdGenerator,
  type Millis,
  type NewRequestInput,
} from '@raag/domain';

/**
 * Deterministic clock for tests and (if wired) the expiry monitor.
 * NEVER uses wall time — time only moves when a test says so
 * (testing.md rule 2).
 */
export interface FakeClock extends Clock {
  /** Current reading. */
  readonly current: () => Millis;
  /** Move forward by `deltaMs` (must be >= 0; throws otherwise). */
  advance(deltaMs: number): void;
  /** Jump to an absolute instant (must be >= current). */
  setTo(instantMs: number): void;
}

export function createFakeClock(initialMs = 1_700_000_000_000): FakeClock {
  let now = millisOf(initialMs);
  return {
    now: () => now,
    current: () => now,
    advance(deltaMs) {
      if (!Number.isInteger(deltaMs) || deltaMs < 0) {
        throw new RangeError('fake clock: advance requires a non-negative integer ms');
      }
      now = millisOf(now + deltaMs);
    },
    setTo(instantMs) {
      const next = millisOf(instantMs);
      if (next < now) {
        throw new RangeError('fake clock: setTo cannot move backwards');
      }
      now = next;
    },
  };
}

/** Production clock implementation (domain stays Node-free, so it lives here). */
export function createSystemClock(): Clock {
  return { now: () => millisOf(Date.now()) };
}

/** Deterministic id supply for tests. */
export function createFixedIdGenerator(prefix = 'id'): IdGenerator {
  let seq = 0;
  return { newId: () => `${prefix}-${(seq += 1)}` };
}

/** Audit events collected in memory for assertions. */
export interface CollectingAuditSink extends AuditSink {
  readonly events: () => readonly AuditEvent[];
  /** Test switch: make the NEXT append reject (audit-failure fail-closed path). */
  failNextAppend(reason?: string): void;
}

export function createCollectingAuditSink(): CollectingAuditSink {
  const stored: AuditEvent[] = [];
  let failWith: string | undefined;
  return {
    append(event) {
      if (failWith !== undefined) {
        const why = failWith;
        failWith = undefined;
        return Promise.reject(new Error(why));
      }
      stored.push(event);
      return Promise.resolve();
    },
    events: () => stored,
    failNextAppend(reason) {
      failWith = reason ?? 'audit-write-failed';
    },
  };
}

/** Valid-by-construction request for tests; override anything except shape. */
export const TEST_HASH = 'ab'.repeat(32);

export function testRequestInput(overrides: Partial<NewRequestInput> = {}): NewRequestInput {
  return {
    requestId: 'req-test-0001',
    correlationId: 'corr-test-0001',
    agent: { kind: 'claude-code', version: 'test-fixture' },
    machine: { id: 'machine-test', displayName: 'test machine' },
    project: { id: 'proj-test', displayPath: '/tmp/test-project' },
    session: { sessionId: 'sess-test' },
    action: {
      tool: 'bash',
      displaySummary: 'run: npm test',
      payloadSha256: TEST_HASH,
      payloadBytes: 15,
    },
    risk: 'medium',
    requestedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function createdTestRequest(overrides: Partial<NewRequestInput> = {}): ApprovalRequest {
  return createApprovalRequest(testRequestInput(overrides));
}

export function pendingTestRequest(overrides: Partial<NewRequestInput> = {}): ApprovalRequest {
  const created = createdTestRequest(overrides);
  const outcome = advance(created, { type: 'persisted' });
  if (outcome.kind !== 'advanced') {
    throw new Error('test fixture invariant broken');
  }
  return outcome.request;
}
