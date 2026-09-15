/**
 * Ports owned by the domain layer (architecture.md §4-§5, ADR-003/020):
 * pure interfaces over domain types with no vendor, storage, network, or
 * process semantics. The application package additionally owns interaction
 * ports (policy, notification, channel, transport, adapter) — see
 * application/PORTS-PLACEMENT.md notes in ADR-020.
 */
import type { AuditEvent } from './audit.js';
import type { RequestId } from './ids.js';
import type { ApprovalRequest } from './request.js';
import type { Millis } from './time.js';

/** The one allowed time source. Production uses a real clock; tests a fake. */
export interface Clock {
  now(): Millis;
}

/** Raw-ID minting; the output is validated against ID rules when branded. */
export interface IdGenerator {
  newId(): string;
}

export type RepositoryAddOutcome = 'stored' | 'duplicate-request-id';

/**
 * Durable store for requests (repository-port contract; in-memory impl is
 * test/dev only, SQLite impl arrives with the database phase, ADR-009/010).
 *
 * `compareAndSwap` expresses the optimistic-concurrency contract the domain
 * requires (version guard). In-memory satisfies it cooperatively; a real
 * database phase must enforce it transactionally per ADR-010 conformance.
 */
export interface ApprovalRepository {
  add(request: ApprovalRequest): Promise<RepositoryAddOutcome>;
  findById(requestId: RequestId): Promise<ApprovalRequest | undefined>;
  compareAndSwap(
    request: ApprovalRequest,
    expectedVersion: number,
  ): Promise<'updated' | 'missing' | 'version-conflict'>;
  /** All pending requests (expiry sweeps; expected small in v1). */
  listPending(): Promise<readonly ApprovalRequest[]>;
}

/** Durable audit stream; append MUST precede any visible decision (§17). */
export interface AuditSink {
  append(event: AuditEvent): Promise<void>;
}
