/**
 * @raag/cli — Operator CLI: install/configure/doctor/status. Placeholder only in Phase 1.
 *
 * Phase 1 scaffold: placeholders only. Implementation per
 * docs/architecture.md lands in Phase 2+.
 */
import { packageName as core } from '@raag/core';

export const appName = '@raag/cli' as const;
export function identity(): readonly string[] {
  return [appName, core];
}
