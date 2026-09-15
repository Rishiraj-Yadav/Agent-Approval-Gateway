/**
 * @raag/local-gateway — Process entry: composition root wiring loopback transport + adapters + core + Telegram (architecture.md §9).
 *
 * Phase 1 scaffold: placeholders only. Implementation per
 * docs/architecture.md lands in Phase 2+.
 */
import { packageName as core } from '@raag/core';

export const appName = '@raag/local-gateway' as const;
export function identity(): readonly string[] {
  return [appName, core];
}
