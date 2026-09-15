/**
 * The local gateway core (ADR-034): transports feed NDJSON frame lines here;
 * nothing reaches the application layer unvalidated.
 *
 * Pipeline: byte cap → strict envelope parse → verifyMac (constant-time)
 * → replay/skew guard → scope re-check against stored data → ApprovalManager.
 *
 * Responses carry identity fields + stable reason codes only — never
 * secrets, never raw input echoes (security.md §5/§28).
 */
import type { ApprovalRequest, Clock, Millis } from '@raag/domain';
import { parseRequestId, type RequestId } from '@raag/domain';
import { ApprovalManager, type ResolveResult } from '@raag/application';
import type { SqliteStore } from '@raag/database';
import {
  MAX_LOCAL_FRAME_BYTES,
  ackFor,
  parseLocalEnvelope,
  serializeResponse,
  type InboundMessage,
  type ResponseFrame,
} from '@raag/protocol';
import { ReplayGuard, redactString, verifyMac } from '@raag/security';
import { WaiterRegistry } from './waiters.js';

/** max simultaneously-open local connections (§28 resource bound). */
export const MAX_CONNECTIONS = 16;
/** default expiry-sweep cadence for a running gateway. */
export const DEFAULT_SWEEP_INTERVAL_MS = 1_000;

export type ErrorReason = Extract<ResponseFrame, { kind: 'error' }>['reasonCode'];
export type CloseDecision = 'keep' | 'close';
export type Emit = (frameLine: string) => void;

export interface GatewayCoreDeps {
  readonly store: SqliteStore;
  readonly localKey: string;
  readonly clock: Clock;
}

export class GatewayCore {
  readonly manager: ApprovalManager;
  readonly #key: string;
  readonly #clock: Clock;
  readonly #replay: ReplayGuard;
  readonly #waiters: WaiterRegistry;
  #closing = false;

  constructor(deps: GatewayCoreDeps) {
    if (deps.localKey.length < 32) {
      throw new Error('gateway: local key too short — refusing to serve (fail closed)');
    }
    this.#key = deps.localKey;
    this.#clock = deps.clock;
    this.manager = new ApprovalManager({
      repository: deps.store.repository,
      audit: deps.store.audit,
      clock: deps.clock,
      tx: deps.store.transactionScope,
    });
    this.#replay = new ReplayGuard(() => this.#now());
    this.#waiters = new WaiterRegistry(() => this.#now());
  }

  get closing(): boolean {
    return this.#closing;
  }

  /** Process one inbound line. A pending `submit` emits an ack NOW, and its
   * terminal frame follows on `emit` later (via the attached waiter §20). */
  async handleLine(line: string, emit: Emit): Promise<CloseDecision> {
    if (this.#closing) {
      emit(this.#errorLine('shutdown'));
      return 'close';
    }
    if (Buffer.byteLength(line, 'utf8') > MAX_LOCAL_FRAME_BYTES) {
      emit(this.#errorLine('frame-too-large'));
      return 'close';
    }
    const env = parseLocalEnvelope(line);
    if (!env.ok) {
      emit(this.#errorLine('parse-failed'));
      return 'close';
    }
    // authenticate BEFORE replay bookkeeping or state: a forger must not be
    // able to pollute the nonce cache.
    if (!verifyMac(this.#key, env.envelope.canonical, env.envelope.mac)) {
      emit(this.#errorLine('auth-failed'));
      return 'close';
    }
    const replay = this.#replay.check(env.envelope.ts, env.envelope.nonce);
    if (!replay.ok) {
      emit(
        this.#errorLine(
          replay.reason === 'future-timestamp'
            ? 'future-timestamp'
            : replay.reason === 'stale-timestamp'
              ? 'stale-timestamp'
              : 'replayed',
        ),
      );
      return 'close';
    }
    // any fault below is closed: 'internal' with no detail, connection kept
    // (the failure could be store-side and transient; auth already passed).
    try {
      await this.#dispatch(env.envelope.message, emit);
    } catch {
      emit(this.#errorLine('internal'));
    }
    return 'keep';
  }

  /** Scheduled sweep (§20): expire lapsed pendings, wake their waiters. */
  async sweep(now?: Millis): Promise<number> {
    const ids = await this.manager.expireDue(now ?? this.#now());
    for (const id of ids) {
      const rec = await this.manager.get(id);
      if (rec !== undefined) this.#waiters.resolveTerminal(rec);
    }
    return ids.length;
  }

  /** Startup reconciliation (§12): NEVER approves; reports counts. */
  async reconcileStartup(
    now?: Millis,
  ): Promise<{ expired: number; abandoned: number; stillPending: number }> {
    const report = await this.manager.reconcile(now ?? this.#now());
    return {
      expired: report.expired.length,
      abandoned: report.abandoned.length,
      stillPending: report.stillPending,
    };
  }

  /** Stop serving. Waiters are released WITHOUT decisions — shutdown can
   * never be an approval (§21). */
  beginShutdown(): void {
    this.#closing = true;
    this.#waiters.clearAll();
  }

  #now(): Millis {
    return this.#clock.now();
  }

  #errorLine(reasonCode: ErrorReason): string {
    const frame: ResponseFrame = { v: 'raag.v1', kind: 'error', reasonCode };
    return serializeResponse(frame);
  }

  async #dispatch(msg: InboundMessage, emit: Emit): Promise<void> {
    const id = parseRequestIdOrUndefined(msg.requestId);
    if (id === undefined) {
      emit(this.#errorLine('invalid-message'));
      return;
    }
    switch (msg.kind) {
      case 'submit':
        await this.#onSubmit(msg, emit);
        return;
      case 'decision': {
        const cur = await this.#scoped(id, msg.machineId, msg.correlationId);
        if (cur === undefined) {
          emit(this.#errorLine('unknown-request'));
          return;
        }
        await this.#after(cur, await this.manager.decide(cur.requestId, msg.decision), emit);
        return;
      }
      case 'cancel': {
        const cur = await this.#scoped(id, msg.machineId, msg.correlationId);
        if (cur === undefined) {
          emit(this.#errorLine('unknown-request'));
          return;
        }
        await this.#after(
          cur,
          await this.manager.resolve(cur.requestId, {
            type: 'cancelled',
            now: this.#now(),
          }),
          emit,
        );
        return;
      }
      case 'agent-disconnected': {
        const cur = await this.#scoped(id, msg.machineId, msg.correlationId);
        if (cur === undefined) {
          emit(this.#errorLine('unknown-request'));
          return;
        }
        await this.#after(
          cur,
          await this.manager.resolve(cur.requestId, {
            type: 'agent-disconnected',
            now: this.#now(),
          }),
          emit,
        );
        return;
      }
      case 'status': {
        const cur = await this.#scoped(id, msg.machineId, msg.correlationId);
        if (cur === undefined) {
          emit(this.#errorLine('unknown-request'));
          return;
        }
        emit(this.#ackLine(cur));
        return;
      }
      default:
        // inbound 'reject' kinds are relay vocabulary, not local-channel
        emit(this.#errorLine('invalid-message'));
    }
  }

  async #onSubmit(msg: SubmitWire, emit: Emit): Promise<void> {
    const res = await this.manager.submit({
      requestId: msg.requestId,
      correlationId: msg.correlationId,
      agent: { kind: msg.agent.kind, version: msg.agent.version },
      machine: { id: msg.machineId },
      project: { id: msg.projectId },
      session: { sessionId: msg.sessionId },
      action: {
        tool: msg.action.tool,
        // defense-in-depth (§33 "never trust raw IPC input"): another host's
        // adapter is a peer, not us; re-pass the only human-facing string
        // through security before it can become durable.
        displaySummary: redactString(msg.action.displaySummary),
        payloadSha256: msg.action.payloadSha256,
        payloadBytes: msg.action.payloadBytes,
      },
      risk: msg.risk,
      requestedAt: msg.requestedAtMs, // manager re-stamps from the CORE clock
      ttlSeconds: msg.ttlSeconds,
    });
    if ('rejected' in res) {
      emit(this.#errorLine('invalid-message'));
      return;
    }
    emit(this.#ackLine(res));
    if (res.state === 'pending') {
      const waiter = this.#waiters.attach(res);
      if (waiter !== undefined) {
        void waiter.then((outcome) => {
          if (outcome.kind !== 'terminal' || this.#closing) return;
          try {
            emit(this.#ackLine(outcome.request));
          } catch {
            /* socket already gone; entry was removed by settle */
          }
        });
      }
    }
  }

  /**
   * Scope re-check against STORED data: asserted machineId+correlationId must
   * match, else a uniform unknown-request. This kills cross-scope attempts by
   * an authenticated-but-misplaced caller (no oracle into other machines).
   */
  async #scoped(
    id: RequestId,
    machineId: string,
    correlationId: string,
  ): Promise<ApprovalRequest | undefined> {
    const found = await this.manager.get(id);
    if (
      found === undefined ||
      found.machine.id !== machineId ||
      found.correlationId !== correlationId
    ) {
      return undefined;
    }
    return found;
  }

  async #after(before: ApprovalRequest, res: ResolveResult, emit: Emit): Promise<void> {
    if (res.outcome === 'audit-failed') {
      emit(this.#errorLine('internal'));
      return;
    }
    if (res.outcome === 'unknown') {
      emit(this.#errorLine('unknown-request'));
      return;
    }
    // any post-transition outcome (including duplicate/conflict) must reflect
    // the CURRENT stored state so callers converge on one truth per request.
    const latest = (await this.manager.get(before.requestId)) ?? before;
    this.#waiters.resolveTerminal(latest);
    emit(this.#ackLine(latest));
  }

  #ackLine(req: ApprovalRequest): string {
    return serializeResponse(
      ackFor({
        requestId: req.requestId,
        correlationId: req.correlationId,
        state: req.state,
        version: req.version,
        expiresAt: req.expiresAt,
        ...(req.decision === undefined ? {} : { decision: { kind: req.decision.kind } }),
        ...(req.failureCode === undefined ? {} : { failureCode: req.failureCode }),
      }),
    );
  }
}

type SubmitWire = Extract<InboundMessage, { kind: 'submit' }>;

export function parseRequestIdOrUndefined(raw: string): RequestId | undefined {
  try {
    return parseRequestId(raw);
  } catch {
    return undefined;
  }
}
