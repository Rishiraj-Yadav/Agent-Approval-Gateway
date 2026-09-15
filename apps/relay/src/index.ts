/**
 * @raag/relay — Remote-approval relay host over TLS with per-gateway keys (architecture.md §10). Placeholder only in Phase 1.
 *
 * Phase 1 scaffold: placeholders only. Implementation per
 * docs/architecture.md lands in Phase 2+.
 */
import { packageName as protocol } from '@raag/protocol';

export const appName = '@raag/relay' as const;
export function identity(): readonly string[] {
  return [appName, protocol];
}
