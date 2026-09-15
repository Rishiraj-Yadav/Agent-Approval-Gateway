import {
  type ApprovalRepository,
  type ApprovalRequest,
  type AuditEvent,
  type AuditSink,
  type RepositoryAddOutcome,
  type RequestId,
} from '@raag/domain';

/**
 * @raag/database — durable-state implementations behind repository ports
 * (ADR-009/010). Phase 2: IN-MEMORY only (tests/dev; process state dies with
 * the process — no crash persistence claimed). SQLite/PostgreSQL backends
 * land in the database phase and MUST pass the shared conformance suite in
 * @raag/testing against this same port.
 *
 * The repository is single-writer cooperative: `compareAndSwap` implements
 * the optimistic-concurrency contract the domain requires (version guard).
 * A real DB must provide the identical outcome vocabulary transactionally.
 */
export const packageName = '@raag/database' as const;

/** In-memory approval store. NOT persistence. Documented at import sites. */
export class InMemoryApprovalRepository implements ApprovalRepository {
  #stored = new Map<RequestId, ApprovalRequest>();

  add(request: ApprovalRequest): Promise<RepositoryAddOutcome> {
    if (this.#stored.has(request.requestId)) {
      return Promise.resolve('duplicate-request-id');
    }
    this.#stored.set(request.requestId, request);
    return Promise.resolve('stored');
  }

  findById(requestId: RequestId): Promise<ApprovalRequest | undefined> {
    return Promise.resolve(this.#stored.get(requestId));
  }

  compareAndSwap(
    request: ApprovalRequest,
    expectedVersion: number,
  ): Promise<'updated' | 'missing' | 'version-conflict'> {
    const existing = this.#stored.get(request.requestId);
    if (existing === undefined) {
      if (expectedVersion !== 0) {
        return Promise.resolve('missing');
      }
      this.#stored.set(request.requestId, request);
      return Promise.resolve('updated');
    }
    if (existing.version !== expectedVersion || request.version !== expectedVersion + 1) {
      return Promise.resolve('version-conflict');
    }
    // Identity/scope/timer fields are immutable after insert; a CAS that
    // tries to reshape them is rejected (never silently accepted).
    if (
      existing.requestId !== request.requestId ||
      existing.correlationId !== request.correlationId ||
      existing.requestedAt !== request.requestedAt ||
      existing.expiresAt !== request.expiresAt ||
      existing.machine.id !== request.machine.id ||
      existing.project.id !== request.project.id ||
      existing.session.sessionId !== request.session.sessionId
    ) {
      return Promise.resolve('version-conflict');
    }
    this.#stored.set(request.requestId, request);
    return Promise.resolve('updated');
  }

  listPending(): Promise<readonly ApprovalRequest[]> {
    const pending = [...this.#stored.values()].filter((r) => r.state === 'pending');
    return Promise.resolve(pending);
  }

  listLive(): Promise<readonly ApprovalRequest[]> {
    const live = [...this.#stored.values()].filter(
      (r) => r.state === 'pending' || r.state === 'created',
    );
    return Promise.resolve(live);
  }

  /** Transaction-scope snapshot/restore (cooperative atomicity, ADR-030). */
  snapshot(): ReadonlyMap<RequestId, ApprovalRequest> {
    return new Map(this.#stored);
  }
  restore(snapshotEntries: ReadonlyMap<RequestId, ApprovalRequest>): void {
    this.#stored = new Map(snapshotEntries);
  }

  /** Test helper — NOT part of the port. Never used by production code. */
  size(): number {
    return this.#stored.size;
  }
}

/**
 * In-memory audit events. Production persistence (append-only SQLite audit
 * table, architecture.md §11) arrives with the database phase; until this is
 * explicitly NOT crash-recoverable.
 */
export class InMemoryAuditSink implements AuditSink {
  #events: AuditEvent[] = [];

  append(event: AuditEvent): Promise<void> {
    this.#events.push(event);
    return Promise.resolve();
  }

  snapshot(): readonly AuditEvent[] {
    return [...this.#events];
  }
  restore(snapshotEvents: readonly AuditEvent[]): void {
    this.#events = [...snapshotEvents];
  }

  /** Test helper — returns a frozen snapshot. */
  events(): readonly AuditEvent[] {
    return Object.freeze([...this.#events]);
  }
}
