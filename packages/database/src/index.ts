/**
 * @raag/database — SQLite Repository implementation (better-sqlite3 added when the schema lands — Phase 3, ADR-009) and the in-memory conformance twin.
 *
 * Phase 1 scaffold: placeholders only. Implementation per
 * docs/architecture.md lands in Phase 2+.
 */
import { packageName as domain } from '@raag/domain';

export const packageName = '@raag/database' as const;
export const builtOn = domain;
