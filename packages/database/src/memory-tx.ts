import type { TransactionScope } from '@raag/domain';
import type { InMemoryApprovalRepository, InMemoryAuditSink } from './storage.js';

/**
 * Cooperative transaction scope for the in-memory store (ADR-030 mirror of
 * SQLite's BEGIN/ROLLBACK): a throw inside `fn` restores the exact
 * repository+audit map contents from before the call. Single-threaded JS has
 * no partial-write interleaving, so snapshot/restore is faithful semantics.
 *
 * This is a TEST/DEV convenience; production durability is SqliteStore, and
 * nothing imports this automatically as a silent fallback (§22/#33).
 */
export function inMemoryTransactionScope(
  repository: InMemoryApprovalRepository,
  audit: InMemoryAuditSink,
): TransactionScope {
  return {
    async run<T>(fn: () => T | Promise<T>): Promise<T> {
      const requestSnapshot = repository.snapshot();
      const auditSnapshot = audit.snapshot();
      try {
        return await fn();
      } catch (error) {
        repository.restore(requestSnapshot);
        audit.restore(auditSnapshot);
        throw error;
      }
    },
  };
}
