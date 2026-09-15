import { type DatabaseSync } from 'node:sqlite';
import type {
  ApprovalRepository,
  ApprovalRequest,
  AuditEvent,
  AuditSink,
  Clock,
  RepositoryAddOutcome,
  RequestId,
  TransactionScope,
} from '@raag/domain';
import { openDatabase, type PragmaReport, readPragmas } from './connection.js';
import {
  decodeAuditRow,
  encodeAuditEvent,
  IMMUTABLE_ROW_FIELDS,
  requestColumns,
  requestInsertParams,
  rowToRequest,
  type AuditRow,
  type RequestRow,
} from './codec.js';
import { migrate } from './migrations.js';

/**
 * SQLite durable store (ADR-031/032/033; updates ADR-009: the driver is
 * Node's built-in `node:sqlite` — zero runtime dependencies, synchronous
 * semantics matching the single-writer/concurrent-reader model).
 *
 * Atomic CAS contract (§9, ADR-033): the transition is ONE UPDATE whose WHERE
 * pins the expected revision AND every immutable identity/scope/timer column.
 * Concurrent writers serialize on SQLite's write lock; exactly one observes
 * `changes = 1`, everyone else receives a deterministic 'version-conflict'
 * (or 'missing'). Terminal states are unreachable by CAS because no caller
 * can pass a stale expected revision once a winner bumped it.
 *
 * Durability (§7/§13): WAL journal + `synchronous=FULL` (fsync per commit),
 * `busy_timeout` 5 s, foreign keys on, `PRAGMA quick_check` on every open,
 * migrations in `BEGIN IMMEDIATE` transactions. A commit that returns to the
 * caller survived process crash; state mid-transaction did not.
 */
export interface SqliteStore {
  readonly repository: SqliteApprovalRepository;
  readonly audit: AuditStore;
  readonly clock: Clock;
  readonly transactionScope: TransactionScope;
  pragmas(): PragmaReport;
  /** Close + checkpoint. After close every operation fails (closed handle). */
  close(): void;
}

export interface AuditStore extends AuditSink {
  /** Review/test helper (not part of the domain port). */
  forRequest(requestId: string): readonly Record<string, unknown>[];
  count(): number;
}

/** Extra repository surface beyond the domain port (listLive for restart
 * reconciliation). The port methods come first and behave identically. */
export interface SqliteApprovalRepository extends ApprovalRepository {
  /** Rows still in a live state (created/pending) — restart reconciliation. */
  listLive(): Promise<readonly ApprovalRequest[]>;
}

interface TxHandle {
  /** Serialize whole transactions: run(fn) executes fn with an exclusive
   * BEGIN IMMEDIATE..COMMIT — queued behind any transaction already
   * in-flight, regardless of awaits inside fn (awaiting would otherwise
   * let a second logical txn interleave BEGINs on the same connection). */
  exclusive<T>(fn: () => T | Promise<T>): Promise<T>;
}

function makeTx(db: DatabaseSync): TxHandle {
  // promise chain = FIFO mutex over the single synchronous connection.
  let tail: Promise<unknown> = Promise.resolve();
  return {
    exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
      const runOne = async (): Promise<T> => {
        db.exec('BEGIN IMMEDIATE;');
        try {
          const value = await fn();
          db.exec('COMMIT;');
          return value;
        } catch (error) {
          if (db.isTransaction) {
            try {
              db.exec('ROLLBACK;');
            } catch {
              /* keep original error primary */
            }
          }
          throw error;
        }
      };
      const result = tail.then(runOne, runOne);
      // chain keeps flowing past rejections:
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

const CAS_COLUMNS = IMMUTABLE_ROW_FIELDS.map((c) => `${c} = :${c}`).join(' AND\n            ');

class SqliteApprovalRepositoryImpl implements SqliteApprovalRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: Clock,
  ) {}

  add(request: ApprovalRequest): Promise<RepositoryAddOutcome> {
    return Promise.resolve().then(() => {
      try {
        this.db
          .prepare(
            `INSERT INTO approval_requests (${requestColumns.insertList})
             VALUES (${requestColumns.insertPlaceholders})`,
          )
          .run(requestInsertParams(request));
        return 'stored' as const;
      } catch (error) {
        if (String((error as Error).message).includes('UNIQUE constraint')) {
          return 'duplicate-request-id' as const;
        }
        throw error;
      }
    });
  }

  findById(requestId: RequestId): Promise<ApprovalRequest | undefined> {
    return Promise.resolve().then(() => {
      const row = this.db
        .prepare(`SELECT ${requestColumns.insertList} FROM approval_requests WHERE request_id = ?`)
        .get(requestId) as RequestRow | undefined;
      return row === undefined ? undefined : rowToRequest(row, this.clock.now());
    });
  }

  compareAndSwap(
    request: ApprovalRequest,
    expectedVersion: number,
  ): Promise<'updated' | 'missing' | 'version-conflict'> {
    return Promise.resolve().then(() => {
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
        // insert-new CAS (same semantics as the in-memory reference store)
        if (expectedVersion === 0) {
          return this.add(request).then((added) =>
            added === 'stored' ? ('updated' as const) : ('version-conflict' as const),
          );
        }
        return 'version-conflict' as const;
      }
      // revision arithmetic is invalid input, not a write conflict — and the
      // UPDATE is never attempted with it (checked BEFORE execution).
      if (request.version !== expectedVersion + 1) return 'version-conflict' as const;
      const params = { ...requestInsertParams(request), expected_revision: expectedVersion };
      const result = this.db
        .prepare(
          `UPDATE approval_requests
              SET state = :state,
                  revision = :revision,
                  decision_kind = :decision_kind,
                  decided_at = :decided_at,
                  failure_code = :failure_code
            WHERE request_id = :request_id
              AND revision = :expected_revision
              AND ${CAS_COLUMNS}`,
        )
        .run(params);
      if (typeof result.changes === 'number' && result.changes === 1) {
        return 'updated' as const;
      }
      const exists = this.db
        .prepare('SELECT 1 AS hit FROM approval_requests WHERE request_id = ?')
        .get(request.requestId);
      return exists === undefined ? ('missing' as const) : ('version-conflict' as const);
    });
  }

  listPending(): Promise<readonly ApprovalRequest[]> {
    return Promise.resolve().then(() => {
      const rows = this.db
        .prepare(
          `SELECT ${requestColumns.insertList} FROM approval_requests
            WHERE state = 'pending' ORDER BY requested_at`,
        )
        .all() as unknown as RequestRow[];
      return rows.map((row) => rowToRequest(row, this.clock.now()));
    });
  }

  listLive(): Promise<readonly ApprovalRequest[]> {
    return Promise.resolve().then(() => {
      const rows = this.db
        .prepare(
          `SELECT ${requestColumns.insertList} FROM approval_requests
            WHERE state IN ('created', 'pending') ORDER BY requested_at`,
        )
        .all() as unknown as RequestRow[];
      return rows.map((row) => rowToRequest(row, this.clock.now()));
    });
  }
}

class SqliteAuditStoreImpl implements AuditStore {
  constructor(private readonly db: DatabaseSync) {}

  append(event: AuditEvent): Promise<void> {
    return Promise.resolve().then(() => {
      const { params } = encodeAuditEvent(event);
      this.db
        .prepare(
          `INSERT INTO audit_events
              (occurred_at, type, actor, severity, request_id, correlation_id, detail_json)
           VALUES (:occurred_at, :type, :actor, :severity, :request_id, :correlation_id, :detail_json)`,
        )
        .run(params);
    });
  }

  forRequest(requestId: string): readonly Record<string, unknown>[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_events WHERE request_id = ? ORDER BY seq')
      .all(requestId) as unknown as AuditRow[];
    return rows.map(decodeAuditRow);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM audit_events').get() as unknown as {
      c: number | bigint;
    };
    return Number(row.c);
  }
}

export interface OpenSqliteStoreOptions {
  readonly path: string;
  readonly clock: Clock;
}

/** Opens (creating if absent) the local ledger: pragmas → integrity probe →
 * migrations → ready. Any failure throws — the gateway must not start. */
export function openSqliteStore(options: OpenSqliteStoreOptions): SqliteStore {
  const db = openDatabase(options.path);
  try {
    migrate(db);
  } catch (error) {
    try {
      db.close();
    } catch {
      /* broken handle after failed migration */
    }
    throw error;
  }
  const tx = makeTx(db);
  const repository = new SqliteApprovalRepositoryImpl(db, options.clock);
  const audit = new SqliteAuditStoreImpl(db);

  const transactionScope: TransactionScope = {
    /** Serialized: queued exclusive BEGIN IMMEDIATE..COMMIT (see makeTx). */
    run<T>(fn: () => T | Promise<T>): Promise<T> {
      return tx.exclusive(fn);
    },
  };

  return {
    repository,
    audit,
    clock: options.clock,
    transactionScope,
    pragmas: () => readPragmas(db),
    /**
     * Close the ledger immediately. NOT safe to call while transactions are
     * in flight: the shutdown owner (gateway) must first stop accepting work
     * (an open write would hit a closed handle and fail CLOSED, never half).
     */
    close: () => {
      if (db.isTransaction) {
        try {
          db.exec('ROLLBACK;');
        } catch {
          /* closing anyway; an unclosed txn cannot survive close */
        }
      }
      db.close();
    },
  };
}
