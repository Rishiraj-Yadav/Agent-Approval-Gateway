import { describe, expect, it } from 'vitest';
import type { AuditSink, PolicyOutcome } from '@raag/domain';
import { parseRequestId } from '@raag/domain';
import type { PolicyEngine } from '@raag/application';
import { InMemoryApprovalRepository, InMemoryAuditSink } from '@raag/database';
import { ApprovalManager } from '@raag/application';
import { createFakeClock, testRequestInput } from '@raag/testing';

const RID = 'req-mgr-1';

function manager(deps: { policy?: PolicyOutcome | PolicyEngine; notifyThrows?: boolean } = {}) {
  const clock = createFakeClock(1_000);
  const repository = new InMemoryApprovalRepository();
  const audit = new InMemoryAuditSink();
  const policy: PolicyEngine | undefined =
    deps.policy === undefined
      ? undefined
      : typeof deps.policy === 'string'
        ? { evaluate: () => deps.policy as PolicyOutcome }
        : deps.policy;
  const notified: unknown[] = [];
  const mgr = new ApprovalManager({
    repository,
    clock,
    audit,
    policy,
    notifier: {
      prompt(request) {
        if (deps.notifyThrows) throw new Error('telegram down');
        notified.push(request);
      },
      retract() {},
    },
  });
  const submit = (over: Partial<NewInput> = {}) =>
    mgr.submit(testRequestInput({ requestId: RID, correlationId: 'corr-mgr-1', ...over }));
  const rid = () => parseRequestId(RID);
  return { mgr, clock, repository, audit, notified, submit, rid };
}

type NewInput = Parameters<typeof testRequestInput>[0];

describe('ApprovalManager.submit — need-human path (default)', () => {
  it('persists created, transitions to pending, notifies once, audits the chain', async () => {
    const { mgr, submit, audit, notified } = manager();
    const req = await submit();
    expect('rejected' in req ? req.rejected : req.state).toBe('pending');
    if ('state' in req) expect(req.version).toBe(2);
    expect(notified).toHaveLength(1);
    const types = audit.events().map((e) => e.type);
    expect(types).toEqual(['request-created', 'policy-evaluated', 'request-pending']);
    expect(mgr).toBeDefined();
  });

  it('re-stamps requestedAt/expiresAt from the CORE clock — not the caller', async () => {
    const { submit, clock } = manager();
    clock.advance(7_000);
    const req = await submit({ requestedAt: 999_999_999 });
    if (!('state' in req)) throw new Error('unexpected');
    expect(req.requestedAt).toBe(8_000);
    expect(req.expiresAt - req.requestedAt).toBe(120_000);
  });

  it('duplicate requestId submits are idempotent (return live record, not a shadow)', async () => {
    const { mgr, repository, submit, rid } = manager();
    const a = await submit();
    const b = await submit();
    if ('state' in a && 'state' in b) expect(a.version).toBe(b.version);
    expect(await repository.findById(rid())).toBeDefined();
    expect(mgr).toBeDefined();
  });

  it('invalid input is rejected fail-closed, audited, and stored nothing', async () => {
    const { mgr, repository, audit } = manager();
    const res = await mgr.submit(testRequestInput({ requestId: 'bad id' }));
    expect(res).toEqual({ rejected: 'invalid-input' });
    expect(repository.size()).toBe(0);
    expect(audit.events().map((e) => e.type)).toContain('submit-rejected');
  });
});

describe('ApprovalManager.submit — policy outcomes', () => {
  it('auto-deny short-circuits BEFORE any human prompt', async () => {
    const { submit, notified } = manager({ policy: 'auto-deny' });
    const req = await submit();
    expect('state' in req ? req.state : null).toBe('denied');
    expect(notified).toHaveLength(0);
  });

  it('auto-allow flows through the SAME decided path (state machine, not a side door)', async () => {
    const { submit, audit, mgr } = manager({ policy: { evaluate: () => 'auto-allow' } });
    const req = await submit();
    expect('state' in req ? req.state : null).toBe('approved');
    expect(audit.events().some((e) => e.type === 'request-resolved')).toBe(true);
    expect(mgr).toBeDefined();
  });

  it('notification failure leaves the request PENDING (expire closed, audited)', async () => {
    const { submit, audit, repository, rid } = manager({ notifyThrows: true });
    await submit();
    const stored = await repository.findById(rid());
    expect(stored?.state).toBe('pending');
    expect(audit.events().some((e) => e.type === 'notification-failed')).toBe(true);
  });
});

describe('ApprovalManager.decide / resolve', () => {
  it('approve then duplicate approve is idempotent', async () => {
    const { mgr, submit, rid } = manager();
    await submit();
    const first = await mgr.decide(rid(), 'allow-once');
    expect(first.outcome).toBe('advanced');
    const second = await mgr.decide(rid(), 'allow-once');
    expect(second.outcome).toBe('duplicate');
    expect(second.request?.state).toBe('approved');
  });

  it('conflicting decision is reported, terminal state frozen', async () => {
    const { mgr, submit, rid } = manager();
    await submit();
    await mgr.decide(rid(), 'allow-once');
    const deny = await mgr.decide(rid(), 'deny');
    expect(deny.outcome).toBe('conflict');
    expect(deny.request?.state).toBe('approved');
  });

  it('deciding on an unknown id is refused closed (unknown)', async () => {
    const { mgr } = manager();
    const res = await mgr.decide(parseRequestId('req-nope-404'), 'allow-once');
    expect(res.outcome).toBe('unknown');
  });

  it('decide at/after inclusive expiry is rejected — expired requests never approve', async () => {
    const { mgr, submit, rid, clock } = manager();
    await submit({ ttlSeconds: 60 });
    clock.advance(60_000); // now == expiresAt
    const late = await mgr.decide(rid(), 'allow-once');
    expect(late.outcome).toBe('rejected');
    expect(late.reason).toBe('already-expired-at-decision');
  });

  it('cancel is deny-equivalent and audited', async () => {
    const { mgr, submit, rid, audit, clock } = manager();
    await submit();
    const res = await mgr.resolve(rid(), { type: 'cancelled', now: clock.now() });
    expect(res.outcome).toBe('advanced');
    expect(res.request?.state).toBe('cancelled');
    expect(audit.events().some((e) => e.type === 'request-cancelled')).toBe(true);
  });
});

describe('ApprovalManager.expireDue', () => {
  it('sweeps overdue pendings to expired, leaves future ones, returns count', async () => {
    const { mgr, repository, submit, clock } = manager();
    await mgr.submit(
      testRequestInput({
        requestId: 'req-e1',
        correlationId: 'corr-e1',
        ttlSeconds: 10,
      }),
    );
    await submit({ correlationId: 'corr-e2' });
    clock.advance(10_000);
    const n = await mgr.expireDue();
    expect(n).toHaveLength(1);
    expect((await repository.findById(parseRequestId('req-e1')))?.state).toBe('expired');
    expect((await repository.findById(parseRequestId(RID)))?.state).toBe('pending');
    expect(await mgr.expireDue()).toEqual([]);
  });
});

describe('ApprovalManager fail-closed audit coupling', () => {
  it('audit append failure on the decided path yields audit-failed and reverts to pending', async () => {
    const clock = createFakeClock(1_000);
    const repository = new InMemoryApprovalRepository();
    let fail = false;
    const audit: AuditSink = {
      append() {
        if (fail) return Promise.reject(new Error('disk full'));
        return Promise.resolve();
      },
    };
    const mgr = new ApprovalManager({ repository, clock, audit });
    await mgr.submit(testRequestInput({ requestId: RID, correlationId: 'corr-mgr-1' }));
    fail = true;
    const res = await mgr.decide(parseRequestId(RID), 'allow-once');
    expect(res.outcome).toBe('audit-failed');
    const stored = await repository.findById(parseRequestId(RID));
    // Audit-before-store: the decision was NEVER written. The request stays
    // pending (and would expire deny-closed) — an approval without its audit
    // record cannot exist.
    expect(stored?.state).toBe('pending');
  });
});
