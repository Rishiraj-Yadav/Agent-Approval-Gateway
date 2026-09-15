import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { InboundMessage, SubmitMessage } from '@raag/protocol';
import { buildDecisionMessage, buildLocalEnvelope, buildSubmitMessage } from '@raag/protocol';
import { openSqliteStore } from '@raag/database';
import { createFakeClock, createdTestRequest } from '@raag/testing';
import { GatewayCore } from '@raag/local-gateway';

const KEY = 'k9Wm2Zx7Qr4Tv8Ny3Ld6Fc1Bh5Sj0Pg2Ka9Me4Rt7Uo1Xy5Zc3Vb8Nl6Hk0Jf2Gs5Dw';

type Clock = ReturnType<typeof createFakeClock>;

function makeCore() {
  const clock = createFakeClock(1_700_000_000_000);
  const store = openSqliteStore({ path: ':memory:', clock });
  const core = new GatewayCore({ store, localKey: KEY, clock });
  return { core, store, clock };
}

function nonce(): string {
  // hex (first char alnum): base64url can begin with '-'/ '_', which
  // NONCE_PATTERN rejects — must never happen for legitimate traffic
  return randomBytes(12).toString('hex');
}

function submitLine(
  clock: Clock,
  requestId = 'req-gw-1',
  over: { machineId?: string; correlationId?: string; ttlSeconds?: number } = {},
): string {
  const msg: SubmitMessage = buildSubmitMessage({
    requestId,
    correlationId: over.correlationId ?? `corr-${requestId}`,
    machineId: over.machineId ?? 'mach-gw',
    projectId: 'proj-gw',
    sessionId: 'sess-gw',
    agent: { kind: 'claude-code', version: '2.0.0' },
    action: {
      tool: 'Bash',
      displaySummary: 'run: npm test',
      payloadSha256: 'c'.repeat(64),
      payloadBytes: 12,
    },
    risk: 'high',
    requestedAtMs: clock.now(),
    ttlSeconds: over.ttlSeconds ?? 60,
  });
  return buildLocalEnvelope(KEY, msg, clock.now(), nonce());
}

function lifecycleLine(
  clock: Clock,
  kind: 'decision' | 'cancel' | 'agent-disconnected' | 'status',
  requestId = 'req-gw-1',
  over: {
    machineId?: string;
    correlationId?: string;
    decision?: 'allow-once' | 'allow-session' | 'deny' | 'stop-agent';
    fixedNonce?: string;
  } = {},
): string {
  const base = {
    requestId,
    correlationId: over.correlationId ?? `corr-${requestId}`,
    machineId: over.machineId ?? 'mach-gw',
  };
  let msg: InboundMessage;
  if (kind === 'decision') {
    msg = buildDecisionMessage({
      ...base,
      decision: over.decision ?? 'deny',
      token: randomBytes(12).toString('base64url'),
    });
  } else {
    msg = { v: 'raag.v1', kind, ...base };
  }
  return buildLocalEnvelope(KEY, msg, clock.now(), over.fixedNonce ?? nonce());
}

async function run(core: GatewayCore, line: string) {
  const frames: Record<string, unknown>[] = [];
  const close =
    (await core.handleLine(line, (f) => {
      frames.push(JSON.parse(f) as Record<string, unknown>);
    })) === 'close';
  return {
    close,
    frames,
    codes: frames.flatMap((f) => (typeof f['reasonCode'] === 'string' ? [f['reasonCode']] : [])),
  };
}

async function idle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 15));
}

describe('GatewayCore — happy lifecycle (submit → decision → waiter push)', () => {
  it('pending submit acks; decision acks AND wakes the submit connection; correlation preserved', async () => {
    const { core, store, clock } = makeCore();
    const submitter = await run(core, submitLine(clock));
    expect(submitter.close).toBe(false);
    expect(submitter.frames[0]).toMatchObject({
      kind: 'ack',
      requestId: 'req-gw-1',
      state: 'pending',
    });

    const decider = await run(
      core,
      lifecycleLine(clock, 'decision', 'req-gw-1', { decision: 'allow-once' }),
    );
    expect(decider.frames[0]).toMatchObject({ kind: 'ack', state: 'approved' });

    await idle();
    expect(submitter.frames[1]).toMatchObject({ kind: 'ack', state: 'approved' });
    const stored = await store.repository.findById('req-gw-1' as never);
    expect(stored?.state).toBe('approved');
    expect(stored?.correlationId).toBe('corr-req-gw-1');
    store.close();
  });

  it('status snapshots the stored state', async () => {
    const { core, store, clock } = makeCore();
    await run(core, submitLine(clock));
    const st = await run(core, lifecycleLine(clock, 'status'));
    expect(st.frames[0]).toMatchObject({ kind: 'ack', state: 'pending' });
    store.close();
  });

  it('defense-in-depth: a secret-bearing displaySummary is re-redacted before it becomes durable', async () => {
    const { core, store, clock } = makeCore();
    const leaky: InboundMessage = buildSubmitMessage({
      requestId: 'req-leaky',
      correlationId: 'corr-leaky',
      machineId: 'mach-gw',
      projectId: 'proj-gw',
      sessionId: 'sess-gw',
      agent: { kind: 'claude-code', version: '2.0.0' },
      action: {
        tool: 'Bash',
        displaySummary: 'fetch config Authorization: Bearer s3cr3tTokenABC123DEF456',
        payloadSha256: 'a'.repeat(64),
        payloadBytes: 40,
      },
      risk: 'high',
      requestedAtMs: clock.now(),
      ttlSeconds: 60,
    });
    const line = buildLocalEnvelope(KEY, leaky, clock.now(), nonce());
    await run(core, line);
    const stored = await store.repository.findById('req-leaky' as never);
    const text = JSON.stringify(stored);
    expect(text).not.toContain('s3cr3tTokenABC123DEF456');
    expect(stored?.action.displaySummary).toContain('redacted');
    store.close();
  });

  it('cancel and agent-disconnected are deny-equivalent terminals and wake waiters', async () => {
    const { core, store, clock } = makeCore();
    const a = await run(core, submitLine(clock, 'req-x-cancel'));
    await run(core, lifecycleLine(clock, 'cancel', 'req-x-cancel'));
    await idle();
    const b = await run(core, submitLine(clock, 'req-x-disc'));
    await run(core, lifecycleLine(clock, 'agent-disconnected', 'req-x-disc'));
    await idle();
    expect((await store.repository.findById('req-x-cancel' as never))?.state).toBe('cancelled');
    expect((await store.repository.findById('req-x-disc' as never))?.state).toBe(
      'agent-disconnected',
    );
    expect(a.frames.some((f) => f['state'] === 'cancelled')).toBe(true);
    expect(b.frames.some((f) => f['state'] === 'agent-disconnected')).toBe(true);
    store.close();
  });
});

describe('GatewayCore — authentication, replay, scope: fail closed everywhere', () => {
  it('a forged MAC (wrong key, correct shape) authenticates nothing', async () => {
    const { core, store, clock } = makeCore();
    await run(core, submitLine(clock));
    const forged: InboundMessage = {
      v: 'raag.v1',
      kind: 'decision',
      requestId: 'req-gw-1',
      correlationId: 'corr-req-gw-1',
      machineId: 'mach-gw',
      decision: 'allow-once',
      token: randomBytes(12).toString('base64url'),
    };
    const wrongKey = buildLocalEnvelope(
      'WRONGKEY00000000000000000000000000000000000000000000000000000000',
      forged,
      clock.now(),
      nonce(),
    );
    const out = await run(core, wrongKey);
    expect(out.close).toBe(true);
    expect(out.codes).toContain('auth-failed');
    expect((await store.repository.findById('req-gw-1' as never))?.state).toBe('pending');
    store.close();
  });

  it('byte-identical replay of a signed frame is refused; state untouched', async () => {
    const { core, store, clock } = makeCore();
    await run(core, submitLine(clock));
    const fixedNonce = 'FIXED-replay-test-nonce-0001';
    const line = lifecycleLine(clock, 'decision', 'req-gw-1', {
      decision: 'deny',
      fixedNonce,
    });
    const first = await run(core, line);
    expect(first.codes).toEqual([]);
    expect((await store.repository.findById('req-gw-1' as never))?.state).toBe('denied');
    const replay = await run(core, line);
    expect(replay.close).toBe(true);
    expect(replay.codes).toContain('replayed');
    store.close();
  });

  it('wrong-machineId decision answers uniform unknown-request; scope immutable', async () => {
    const { core, store, clock } = makeCore();
    await run(core, submitLine(clock, 'req-scope'));
    const misplaced = lifecycleLine(clock, 'decision', 'req-scope', {
      machineId: 'attacker-machine',
      decision: 'allow-once',
    });
    const out = await run(core, misplaced);
    expect(out.codes).toContain('unknown-request');
    expect((await store.repository.findById('req-scope' as never))?.state).toBe('pending');
    store.close();
  });

  it('oversized frame, non-JSON, and unknown shapes never reach dispatch', async () => {
    const { core, store } = makeCore();
    expect((await run(core, '{"x":"' + 'y'.repeat(300_000) + '"}')).codes).toContain(
      'frame-too-large',
    );
    expect((await run(core, 'not json')).codes).toContain('parse-failed');
    expect((await run(core, '[1,2,3]')).codes).toContain('parse-failed');
    expect(store.audit.count()).toBe(0); // dispatch never executed at all
    store.close();
  });

  it('decision for a never-existing requestId is unknown — never an implicit record', async () => {
    const { core, store, clock } = makeCore();
    const out = await run(core, lifecycleLine(clock, 'decision', 'req-ghost'));
    expect(out.codes).toContain('unknown-request');
    expect(await core.manager.get('req-ghost' as never)).toBeUndefined();
    store.close();
  });
});

describe('GatewayCore — expiry, reconciliation, shutdown', () => {
  it('sweep expires lapsed pendings; a late allow cannot resurrect them', async () => {
    const { core, store, clock } = makeCore();
    await run(core, submitLine(clock, 'req-due', { ttlSeconds: 30 }));
    clock.advance(30_001);
    expect(await core.sweep()).toBe(1);
    expect((await store.repository.findById('req-due' as never))?.state).toBe('expired');
    const late = await run(
      core,
      lifecycleLine(clock, 'decision', 'req-due', { decision: 'allow-once' }),
    );
    expect(late.frames[0]?.['state']).toBe('expired');
    expect((await store.repository.findById('req-due' as never))?.state).toBe('expired');
    store.close();
  });

  it('orphaned `created` rows reconcile to failed(persistence-error), never approved', async () => {
    const { core, store, clock } = makeCore();
    const orphan = createdTestRequest({ requestId: 'req-orphan' });
    await store.repository.add(orphan);
    clock.advance(1_000);
    const report = await core.reconcileStartup();
    expect(report.abandoned).toBe(1);
    const stored = await store.repository.findById('req-orphan' as never);
    expect(stored?.state).toBe('failed');
    expect(stored?.failureCode).toBe('persistence-error');
    const lateApprove = await run(
      core,
      lifecycleLine(clock, 'decision', 'req-orphan', {
        machineId: orphan.machine.id,
        correlationId: orphan.correlationId,
        decision: 'allow-once',
      }),
    );
    expect(lateApprove.frames[0]?.['state']).toBe('failed');
    store.close();
  });

  it('closed database: internal code, request state unchanged, no approvals', async () => {
    const { core, store, clock } = makeCore();
    await run(core, submitLine(clock));
    const before = await store.repository.findById('req-gw-1' as never);
    store.close();
    const out = await run(core, submitLine(clock, 'req-after-close'));
    expect(out.codes).toContain('internal');
    expect(before?.state).toBe('pending');
    if (before === undefined) throw new Error('expected untouched pending');
    expect(before.state).toBe('pending');
  });

  it('an inbound “reject” frame (relay vocabulary) is refused on the local channel', async () => {
    const { core, store, clock } = makeCore();
    const msg: InboundMessage = {
      v: 'raag.v1',
      kind: 'reject',
      requestId: 'r-x1',
      reasonCode: 'policy-deny',
    };
    const out = await run(core, buildLocalEnvelope(KEY, msg, clock.now(), nonce()));
    expect(out.codes).toContain('invalid-message');
    expect(out.close).toBe(false); // a refused message is not an auth/capacity fault
    store.close();
  });

  it('sweep with an explicit now beyond every TTL expires all pendings at once', async () => {
    const { core, store, clock } = makeCore();
    await run(core, submitLine(clock, 'req-s1', { ttlSeconds: 30 }));
    await run(core, submitLine(clock, 'req-s2', { ttlSeconds: 30 }));
    expect(await core.sweep((clock.now() + 5_000) as never)).toBe(0); // not yet due
    expect(await core.sweep((clock.now() + 31_000) as never)).toBe(2);
    store.close();
  });

  it('shutdown: waiters released without decisions, new frames rejected as shutdown', async () => {
    const { core, clock } = makeCore();
    const pending = await run(core, submitLine(clock, 'req-hold'));
    expect(pending.frames[0]).toMatchObject({ state: 'pending' });
    core.beginShutdown();
    const after = await run(core, submitLine(clock, 'req-after'));
    expect(after.codes).toContain('shutdown');
    expect(after.close).toBe(true);
    await idle();
    // no terminal frame was pushed to the held submitter:
    expect(pending.frames).toHaveLength(1);
  });
});
