/**
 * @raag/policy — Policy Engine: deny-first rule evaluation over local rule sets. Never consulted by anything except the Approval Manager.
 *
 * Phase 1 scaffold: placeholders only. Implementation per
 * docs/architecture.md lands in Phase 2+.
 */
import { packageName as domain } from '@raag/domain';

export const packageName = '@raag/policy' as const;
export const builtOn = domain;
