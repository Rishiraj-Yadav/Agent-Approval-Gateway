import type {
  ApprovalRequest,
  ApprovalRepository,
  AuditEventType,
  AuditSink,
  Clock,
  Millis,
  PolicyOutcome,
  RequestId,
  TransactionScope,
} from '@raag/domain';
import {
  advance,
  createApprovalRequest,
  createAuditEvent,
  secondsToDuration,
  shouldExpireAt,
  type DecisionKind,
  type LifecycleEvent,
  type NewRequestInput,
} from '@raag/domain';
import type { NotificationProvider, PolicyEngine } from './ports.js';

/**
 * ApprovalManager — the ONLY component allowed to advance request state,
 * and it does so purely through the domain state machine + the
 * repository/Clock/audit ports + the policy/notification ports. Everything
 * reaching this layer is RE-VALIDATED (fail closed): trust is assumed
 * nowhere between components.
 *
 * Audit-before-deliver invariant (architecture.md §17): a decision that
 * cannot be durably audited is treated as failed, never returned as
 * `advanced`.
 */

/**
 * Result classification for operator/channel-driven decisions. `advanced`
 * tells the caller a delivery to an agent is owed (delivery is a later phase;
 * the classification itself is complete here).
 */
export interface ResolveResult {
  readonly outcome:
    'advanced' | 'duplicate' | 'no-change' | 'conflict' | 'rejected' | 'unknown' | 'audit-failed';
  readonly request?: ApprovalRequest | undefined;
  readonly reason?: string | undefined;
}

export interface ApprovalManagerDeps {
  readonly repository: ApprovalRepository;
  readonly clock: Clock;
  readonly audit: AuditSink;
  /** Absent = every request reaches a human (need-human default). */
  readonly policy?: PolicyEngine | undefined;
  /** Absent NotificationProvider = headless mode (tests/foundation). */
  readonly notifier?: NotificationProvider | undefined;
  /**
   * Durable stores provide ONE transaction for state-write + audit-append
   * (ADR-030). Absent (in-memory/headless) → the manager falls back to the
   * prevention order audit-then-store; with a store, nothing is ever
   * half-applied.
   */
  readonly tx?: TransactionScope | undefined;
}

export class ApprovalManager {
  constructor(readonly deps: ApprovalManagerDeps) {}

  private now(): Millis {
    return this.deps.clock.now();
  }

  /**
   * Ingress used by adapters/transport handlers (loopback HTTP, relay frames —
   * all later phases). Creates a `created` request, persists it (durable
   * FIRST, §17), evaluates policy, short-circuits auto decisions, otherwise
   * moves to `pending` and notifies. Returns the request in its post-policy
   * state. Duplicate requestId ingress is idempotent (returns existing).
   */
  async submit(input: NewRequestInput): Promise<ApprovalRequest | { readonly rejected: string }> {
    const now = this.now();
    // core re-stamps the creation window; caller `requestedAt` is never
    // trusted as "now" (hostile clocks must not extend approval TTLs).
    let request: ApprovalRequest;
    try {
      request = createApprovalRequest({
        ...input,
        requestedAt: now,
        ttlSeconds: input.ttlSeconds === undefined ? undefined : coerceSeconds(input.ttlSeconds),
      });
    } catch {
      await this.auditEvent('submit-rejected', 'warn', { detail: { reason: 'invalid-input' } });
      return { rejected: 'invalid-input' };
    }
    const added = await this.deps.repository.add(request);
    if (added !== 'stored') {
      const existing = await this.deps.repository.findById(request.requestId);
      if (existing === undefined) {
        throw new Error('repository invariant broken: duplicate id with no record');
      }
      await this.auditEvent('submit-rejected', 'info', {
        request,
        detail: { reason: 'duplicate-request-id' },
      });
      return existing;
    }
    await this.auditEvent('request-created', 'info', { request });

    const outcome: PolicyOutcome = this.deps.policy?.evaluate(request) ?? 'need-human';
    await this.auditEvent('policy-evaluated', 'info', {
      request,
      detail: { 'policy-outcome': outcome, risk: request.risk },
    });

    const pendingResult = await this.transition(request, { type: 'persisted' });
    const pendingRecord = pendingResult ?? request;

    // deny-first: an auto-deny never reaches a human prompt. Both auto
    // outcomes flow through the SAME decided path as human decisions — no
    // side doors around the state machine (ADR-007/ADR-019).
    if (outcome === 'auto-deny') {
      return await this.transitionOr(pendingRecord, { type: 'decided', decision: 'deny', now });
    }
    if (outcome === 'auto-allow') {
      return await this.transitionOr(pendingRecord, {
        type: 'decided',
        decision: 'allow-once',
        now,
      });
    }

    if (pendingResult !== undefined) {
      try {
        await this.deps.notifier?.prompt(pendingResult);
      } catch {
        // delivery failure: stay pending → expiry closes it deny-side. Audited.
        await this.auditEvent('notification-failed', 'warn', { request: pendingResult });
      }
    }
    return pendingRecord;
  }

  /**
   * Human/policy decision ingress (later: validated Telegram/relay callbacks)
   * or operator cancel / disconnect notices. Idempotent; duplicates/conflicts
   * are audited and reported, current state returned in all cases.
   */
  async resolve(
    requestId: RequestId,
    event: Extract<LifecycleEvent, { type: 'decided' | 'cancelled' | 'agent-disconnected' }>,
  ): Promise<ResolveResult> {
    return this.settleExisting(requestId, event);
  }

  /** Convenience operator decision at core-clock `now`. */
  async decide(requestId: RequestId, decision: DecisionKind): Promise<ResolveResult> {
    return this.resolve(requestId, { type: 'decided', decision, now: this.now() });
  }

  /**
   * Expiry sweep — a scheduler (gateway) owns WHEN to call this; this owns
   * what. Expired == deny-equivalent terminal state; this NEVER approves.
   * Returns the ids that transitioned (so callers can notify waiters).
   */
  async expireDue(now: Millis = this.now()): Promise<readonly RequestId[]> {
    const pending = await this.deps.repository.listPending();
    const expired: RequestId[] = [];
    for (const req of pending) {
      if (!shouldExpireAt(req, now)) continue;
      const result = await this.settleExisting(req.requestId, { type: 'expired', now });
      if (result.outcome === 'advanced') expired.push(req.requestId);
    }
    return expired;
  }

  /**
   * Startup reconciliation (architecture.md §14 crash notes, Phase 3 §12).
   * NEVER approves anything:
   *  - `pending` rows whose TTL elapsed while the gateway was down →
   *    `expired` (deny-equivalent), audited per request;
   *  - `created` rows (crashed between durable insert and the pending
   *    transition) → `failed` persistence-error (deny-equivalent);
   *  - everything already terminal is left byte-for-byte as-is.
   */
  async reconcile(now: Millis = this.now()): Promise<{
    readonly expired: readonly RequestId[];
    readonly abandoned: readonly RequestId[];
    readonly stillPending: number;
  }> {
    const expired = await this.expireDue(now);
    const abandoned: RequestId[] = [];
    const live = await this.deps.repository.listLive();
    for (const req of live) {
      if (req.state !== 'created') continue;
      const advanced = advance(req, {
        type: 'failed',
        code: 'persistence-error',
        now,
      });
      if (advanced.kind !== 'advanced') continue;
      const res = await this.commitTransition(advanced.request, req.version, {
        type: 'failed',
        code: 'persistence-error',
        now,
      });
      if (res.outcome === 'advanced') abandoned.push(req.requestId);
    }
    const stillPending = (await this.deps.repository.listPending()).length;
    return { expired, abandoned, stillPending };
  }

  async get(requestId: RequestId): Promise<ApprovalRequest | undefined> {
    return this.deps.repository.findById(requestId);
  }

  /* ------------------------------------------------------------ internal */

  private async settleExisting(
    requestId: RequestId,
    event: LifecycleEvent,
  ): Promise<ResolveResult> {
    const existing = await this.deps.repository.findById(requestId);
    if (existing === undefined) {
      // stale/unknown/never-persisted decisions can never be applied —
      // audit + report closed (post-restart stale approvals take this path).
      await this.auditEvent('request-unknown', 'warn', {
        detail: { 'lookup-failed': true },
      });
      return { outcome: 'unknown', reason: 'request-not-found-or-expired' };
    }
    const result = advance(existing, event);
    switch (result.kind) {
      case 'duplicate':
        await this.auditEvent('decision-duplicate', 'info', { request: existing });
        return { outcome: 'duplicate', request: existing };
      case 'no-change':
        await this.auditEvent('decision-duplicate', 'info', { request: existing });
        return { outcome: 'no-change', request: existing };
      case 'conflict':
        await this.auditEvent('decision-conflict', 'warn', {
          request: existing,
          detail: { 'conflicting-decision': result.current },
        });
        return { outcome: 'conflict', request: existing };
      case 'rejected': {
        const type: AuditEventType =
          result.reason === 'already-expired-at-decision' ||
          result.reason === 'cannot-decide-from-non-pending'
            ? 'decision-after-expiry'
            : 'decision-rejected';
        await this.auditEvent(type, 'warn', {
          request: existing,
          detail: { reason: result.reason },
        });
        return { outcome: 'rejected', request: existing, reason: result.reason };
      }
      case 'advanced':
        return this.commitTransition(result.request, existing.version, event);
    }
  }

  /**
   * Commit a state transition + its audit record ATOMICALLY (ADR-030).
   * With a TransactionScope present: CAS then audit inside one database
   * transaction — an audit failure rolls the state write back (never
   * "approved but unaudited"), and CAS conflicts roll back their conflict
   * audit as a no-op write. Without a scope (in-memory reference store):
   * prevention ordering — audit first; if that throws, nothing is stored.
   */
  async commitTransition(
    next: ApprovalRequest,
    expectedVersion: number,
    event: LifecycleEvent,
  ): Promise<ResolveResult> {
    if (this.deps.tx === undefined) {
      // legacy audit-before-store prevention path (in-memory stores)
      try {
        await this.auditTransitionEvent(next, event);
      } catch {
        return { outcome: 'audit-failed', reason: 'audit-before-deliver' };
      }
      const cas = await this.deps.repository.compareAndSwap(next, expectedVersion);
      if (cas !== 'updated') {
        await this.auditEvent('state-write-conflict', 'warn', { request: next });
        const current = await this.deps.repository.findById(next.requestId);
        return { outcome: 'conflict', request: current, reason: 'repository-version-conflict' };
      }
      return { outcome: 'advanced', request: next };
    }

    const work = async (): Promise<ResolveResult> => {
      const cas = await this.deps.repository.compareAndSwap(next, expectedVersion);
      if (cas !== 'updated') {
        const current = await this.deps.repository.findById(next.requestId);
        return {
          outcome: 'conflict',
          request: current,
          reason: `repository-${cas}`,
        };
      }
      await this.auditTransitionEvent(next, event); // throws → rollback
      return { outcome: 'advanced', request: next };
    };

    try {
      return await this.deps.tx.run(work);
    } catch {
      // database/audit failure: transaction rolled back, NOTHING committed —
      // the request stays in its previous state and expires deny-closed.
      return { outcome: 'audit-failed', reason: 'transaction-rolled-back' };
    }
  }

  /** Internal: transition + CAS + audit for submit's post-policy decisions. */
  private async transitionOr(
    request: ApprovalRequest,
    event: LifecycleEvent,
  ): Promise<ApprovalRequest> {
    const next = await this.transition(request, event);
    return next ?? request;
  }

  private async transition(
    request: ApprovalRequest,
    event: LifecycleEvent,
  ): Promise<ApprovalRequest | undefined> {
    const result = advance(request, event);
    if (result.kind !== 'advanced') return undefined;
    const committed = await this.commitTransition(result.request, request.version, event);
    if (committed.outcome === 'advanced') return result.request;
    if (committed.outcome === 'conflict') return committed.request;
    // audit/store failure: caller keeps the pre-transition record (pending
    // rows still expire later; nothing half-applied)
    return undefined;
  }

  private async auditTransitionEvent(
    request: ApprovalRequest,
    event: LifecycleEvent,
  ): Promise<void> {
    let type: AuditEventType = 'state-changed';
    switch (event.type) {
      case 'decided':
        type = 'request-resolved';
        break;
      case 'expired':
        type = 'request-expired';
        break;
      case 'cancelled':
        type = 'request-cancelled';
        break;
      case 'agent-disconnected':
        type = 'request-agent-disconnected';
        break;
      case 'failed':
        type = 'request-failed';
        break;
      case 'persisted':
        type = 'request-pending';
        break;
    }
    await this.auditEvent(type, request.state === 'failed' ? 'error' : 'info', { request });
  }

  /**
   * Throws for transition events so callers can fail closed; swallows
   * best-effort side-channel events.
   */
  private async auditEvent(
    type: AuditEventType,
    severity: 'info' | 'warn' | 'error',
    args: { request?: ApprovalRequest; detail?: Record<string, string | number | boolean> },
  ): Promise<void> {
    const event = createAuditEvent({
      type,
      occurredAt: this.now(),
      actor: 'manager',
      severity,
      ...(args.request === undefined
        ? {}
        : { requestId: args.request.requestId, correlationId: args.request.correlationId }),
      ...(args.detail === undefined ? {} : { detail: args.detail }),
    });
    if (type === 'request-resolved' || type === 'state-changed') {
      await this.deps.audit.append(event); // must not fail — caller fails closed
      return;
    }
    try {
      await this.deps.audit.append(event);
    } catch {
      /* side-channel events best-effort; never blocks a deny path */
    }
  }
}

function coerceSeconds(raw: unknown): number {
  // NewRequestInput guarantees numbers; normalize defensively anyway.
  const n = typeof raw === 'number' ? Math.trunc(raw) : Number(raw);
  secondsToDuration(n); // throws on out-of-range
  return n;
}
