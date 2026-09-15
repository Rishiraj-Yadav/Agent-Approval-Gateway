/**
 * @raag/database — persistence behind the repository/audit ports (ADR-009/010/031/032).
 *
 * - In-memory store: tests/dev only, explicitly NOT crash-persistent. The
 *   cooperative `inMemoryTransactionScope` there is test-faithful snapshot
 *   semantics, never an automatic production fallback.
 * - SQLite store (SqliteStore): durable local ledger on Node's built-in
 *   `node:sqlite`. Migrations + integrity probe run on every open, a failed
 *   migration leaves the previous version intact (nothing serves reads from
 *   a half-upgraded database).
 *
 * Both satisfy the identical ApprovalRepository contract enforced by the
 * shared conformance suite in @raag/testing (ADR-010).
 */
export * from './storage.js';
export { inMemoryTransactionScope } from './memory-tx.js';
export { DatabaseError, openDatabase, readPragmas } from './sqlite/connection.js';
export type { PragmaReport } from './sqlite/connection.js';
export {
  migrate,
  MIGRATIONS,
  SchemaTooNewError,
  TARGET_SCHEMA_VERSION,
  type Migration,
} from './sqlite/migrations.js';
export {
  openSqliteStore,
  type AuditStore,
  type OpenSqliteStoreOptions,
  type SqliteApprovalRepository,
  type SqliteStore,
} from './sqlite/store.js';
