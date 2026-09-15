import type { ApprovalRequest, Millis } from '@raag/domain';

/**
 * WaiterRegistry (§20): lets one local connection attach to an approval and
 * be woken when the request terminates (decision, expiry, cancellation…).
 *
 * Guarantees:
 *  - keyed STRICTLY by requestId; a terminal snapshot whose correlationId
 *    differs from what was registered is refused (no cross-request wake);
 *  - bounded lifetime: the wait never outlives the request's own expiry
 *    (plus grace) — timers always fire and entries are always removed;
 *  - bounded count: over capacity attach fails closed;
 *  - settle/drop are idempotent — duplicate resolutions are harmless;
 *  - clearAll on shutdown resolves waiters NOT as approvals (state 'closed')
 *    and nothing is auto-decided.
 */
export const WAITER_GRACE_MS = 250;
export const MAX_WAITERS = 1024;

export type WaiterOutcome =
  | { readonly kind: 'terminal'; readonly request: ApprovalRequest }
  | { readonly kind: 'expired-wait' }
  | { readonly kind: 'closed' };

interface Entry {
  readonly correlationId: string;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
  finish: (outcome: WaiterOutcome) => void;
}

export class WaiterRegistry {
  #entries = new Map<string, Entry>();
  #disposed = false;

  constructor(private readonly now: () => Millis) {}

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Attach for `expiresAt`-bounded wait. Returns undefined when rejected:
   * registry closed or capacity/flood guard tripped (caller polls instead —
   * never a hidden failure).
   */
  attach(request: ApprovalRequest): Promise<WaiterOutcome> | undefined {
    if (this.#disposed || this.#entries.size >= MAX_WAITERS) return undefined;
    if (this.#entries.has(request.requestId)) {
      // A second attach for the same id gets a plain status poll instead:
      // one waiter per identity keeps cleanup deterministic.
      return undefined;
    }
    const remaining = request.expiresAt - this.now();
    const timeoutMs = Math.max(10, Math.min(remaining + WAITER_GRACE_MS, 3_700_000));
    let finish!: (outcome: WaiterOutcome) => void;
    const promise = new Promise<WaiterOutcome>((resolve) => {
      finish = resolve;
    });
    const timer = setTimeout(() => {
      if (this.#settle(request.requestId)) finish({ kind: 'expired-wait' });
    }, timeoutMs);
    timer.unref?.(); // must never hold the event loop open
    this.#entries.set(request.requestId, {
      correlationId: request.correlationId,
      settled: false,
      timer,
      finish,
    });
    return promise;
  }

  /** Wake the waiter attached to requestId with the terminal snapshot. */
  resolveTerminal(request: ApprovalRequest): boolean {
    const entry = this.#entries.get(request.requestId);
    if (entry === undefined) return false;
    if (entry.correlationId !== request.correlationId) {
      // cross-request resolution attempt — ignore and keep entry (it will
      // expire on its own timer); this must be impossible upstream.
      return false;
    }
    if (!this.#settle(request.requestId)) return false;
    entry.finish({ kind: 'terminal', request });
    return true;
  }

  /** Socket hung up mid-wait: drop the entry WITHOUT fabricating a result. */
  drop(requestId: string): boolean {
    if (!this.#settle(requestId)) return false;
    return true;
  }

  /** Shutdown: resolve outstanding waiters as 'closed'. No approvals. */
  clearAll(): void {
    this.#disposed = true;
    for (const [id, entry] of this.#entries) {
      clearTimeout(entry.timer);
      entry.finish({ kind: 'closed' });
      void id;
    }
    this.#entries.clear();
  }

  #settle(requestId: string): boolean {
    const entry = this.#entries.get(requestId);
    if (entry === undefined || entry.settled) return false;
    entry.settled = true;
    clearTimeout(entry.timer);
    this.#entries.delete(requestId);
    return true;
  }
}
