import { type DatabaseSync } from 'node:sqlite';
import { DatabaseError, currentVersion, setUserVersion } from './connection.js';

/**
 * Versioned, deterministic migrations (ADR-032).
 *  - `PRAGMA user_version` is the single source of schema truth.
 *  - Every pending migration commits inside its own transaction; a failed
 *    migration rolls back with the version unchanged (startup-safe retry).
 *  - A schema NEWER than this binary aborts (fail closed: a downgraded app
 *    must never read or mutate a newer ledger).
 *  - No destructive automatic recreation exists anywhere in this file.
 */
export const TARGET_SCHEMA_VERSION = 1;

export interface Migration {
  readonly version: number;
  readonly up: string;
}

const APPROVAL_STATES_SQL =
  "'created','pending','approved','denied','expired','cancelled','agent-disconnected','failed'";
const DECISION_KINDS_SQL = "'allow-once','allow-session','deny','stop-agent'";
const FAILURE_CODES_SQL = "'persistence-error','audit-failure','delivery-unservable'";
const RISK_LEVELS_SQL = "'low','medium','high','critical'";

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
CREATE TABLE approval_requests (
  request_id        TEXT PRIMARY KEY NOT NULL,
  correlation_id    TEXT NOT NULL,
  agent_kind        TEXT NOT NULL,
  agent_version     TEXT NOT NULL,
  machine_id        TEXT NOT NULL,
  machine_display   TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  project_display   TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  tool              TEXT NOT NULL,
  display_summary   TEXT NOT NULL,
  payload_sha256    TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  payload_bytes     INTEGER NOT NULL CHECK (payload_bytes >= 0),
  risk              TEXT NOT NULL CHECK (risk IN (${RISK_LEVELS_SQL})),
  state             TEXT NOT NULL CHECK (state IN (${APPROVAL_STATES_SQL})),
  requested_at      INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL CHECK (expires_at > requested_at),
  revision          INTEGER NOT NULL CHECK (revision >= 1),
  decision_kind     TEXT CHECK (decision_kind IS NULL OR decision_kind IN (${DECISION_KINDS_SQL})),
  decided_at        INTEGER,
  failure_code      TEXT CHECK (failure_code IS NULL OR failure_code IN (${FAILURE_CODES_SQL})),
  -- ledger coherence (mirrors domain assertStateShape): impossible state/
  -- decision/failure combinations cannot be written even by raw SQL.
  CHECK (
    (state IN ('approved','denied') AND decision_kind IS NOT NULL AND decided_at IS NOT NULL AND failure_code IS NULL)
    OR (state = 'failed' AND failure_code IS NOT NULL AND decision_kind IS NULL)
    OR (state NOT IN ('approved','denied','failed') AND decision_kind IS NULL AND decided_at IS NULL AND failure_code IS NULL)
  )
);
CREATE INDEX idx_requests_pending ON approval_requests (state, expires_at) WHERE state = 'pending';

CREATE TABLE audit_events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at   INTEGER NOT NULL,
  type          TEXT NOT NULL,
  actor         TEXT NOT NULL,
  severity      TEXT NOT NULL,
  request_id    TEXT,
  correlation_id TEXT,
  detail_json   TEXT NOT NULL
);
CREATE INDEX idx_audit_request ON audit_events (request_id, seq);
`,
  },
  // Future migrations append here with strictly increasing `version`s.
];

export class SchemaTooNewError extends DatabaseError {
  constructor() {
    super('migration', 'database schema is newer than this application version');
    this.name = 'SchemaTooNewError';
  }
}

/** Applies all pending migrations. Returns the versions applied (deterministic, idempotent). */
export function migrate(db: DatabaseSync): readonly number[] {
  const version = currentVersion(db);
  if (version > TARGET_SCHEMA_VERSION) throw new SchemaTooNewError();
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    if (m.version !== version + 1) {
      throw new DatabaseError('migration', 'migration history is not contiguous');
    }
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(m.up);
      setUserVersion(db, m.version);
      db.exec('COMMIT;');
      applied.push(m.version);
    } catch (error) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        /* rollback of a failed BEGIN is best-effort; rethrow the original */
      }
      throw new DatabaseError(
        `migration:v${m.version}`,
        `migration failed: ${(error as Error).message.slice(0, 200)}`,
      );
    }
  }
  return applied;
}
