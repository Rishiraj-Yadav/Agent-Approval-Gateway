import { DatabaseSync } from 'node:sqlite';

/**
 * Low-level connection setup for the durable local store (ADR-031).
 * `node:sqlite` (Node's built-in SQLite) is used deliberately: zero runtime
 * dependencies, synchronous API matching the single-writer model, and no
 * native-build supply-chain surface. Requires Node ≥ 22.13 (ADR-031 note).
 */

export class DatabaseError extends Error {
  readonly causeField: string;
  constructor(field: string, message: string) {
    super(message); // never carries path/user input values beyond field text
    this.name = 'DatabaseError';
    this.causeField = field;
  }
}

export interface PragmaReport {
  readonly journalMode: string;
  readonly synchronous: number;
  readonly foreignKeys: number;
  readonly busyTimeoutMs: number;
  readonly userVersion: number;
}

/** Durability posture (architecture.md §11): WAL + FULL means a committed
 * transaction survives OS/process crash at the cost of fsync per commit —
 * the right trade for an approval ledger. busy_timeout serializes writers. */
const WAL_SYNCHRONOUS_FULL = 2;

function num(raw: unknown, fallback: number): number {
  const first =
    typeof raw === 'object' && raw !== null
      ? Object.values(raw as Record<string, unknown>)[0]
      : raw;
  return typeof first === 'number' ? first : fallback;
}

function str(raw: unknown, fallback: string): string {
  const first =
    typeof raw === 'object' && raw !== null
      ? Object.values(raw as Record<string, unknown>)[0]
      : raw;
  return typeof first === 'string' ? first : fallback;
}

export function openDatabase(path: string): DatabaseSync {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch {
    // Fail closed, error-free: a bad path/corrupt file cannot serve decisions.
    throw new DatabaseError('database', 'unable to open approval database');
  }
  try {
    if (path !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec(`PRAGMA synchronous = ${WAL_SYNCHRONOUS_FULL};`);
    } else {
      db.exec('PRAGMA synchronous = 1;');
    }
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    // Integrity probe on every open: a damaged ledger must never approve.
    const check = db.prepare('PRAGMA quick_check').get();
    if (check === undefined || str(check, '') !== 'ok') {
      throw new DatabaseError('database', 'approval database failed integrity check');
    }
  } catch (error) {
    try {
      db.close();
    } catch {
      /* ignore secondary close failure on a dead handle */
    }
    if (error instanceof DatabaseError) throw error;
    throw new DatabaseError('database', 'failed to initialize approval database pragmas');
  }
  return db;
}

export function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get();
  return num(row, 0);
}

export function setUserVersion(db: DatabaseSync, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new DatabaseError('migration', 'user_version must be a non-negative integer');
  }
  db.exec(`PRAGMA user_version = ${version};`);
}

export function readPragmas(db: DatabaseSync): PragmaReport {
  const pick = (sql: string, fallback: string | number): string | number => {
    const row = db.prepare(sql).get();
    if (typeof fallback === 'number') return num(row, fallback);
    return str(row, fallback);
  };
  return {
    journalMode: String(pick('PRAGMA journal_mode', 'delete')),
    synchronous: Number(pick('PRAGMA synchronous', 0)),
    foreignKeys: Number(pick('PRAGMA foreign_keys', 0)),
    busyTimeoutMs: Number(pick('PRAGMA busy_timeout', 0)),
    userVersion: currentVersion(db),
  };
}
