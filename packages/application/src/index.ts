/**
 * @raag/application — Use-case orchestration (Approval Manager entry points, expiry scheduler). Depends only on port interfaces from @raag/domain (+ logging/config).
 *
 * Phase 1 scaffold: placeholders only. Implementation per
 * docs/architecture.md lands in Phase 2+.
 */
import { packageName as domain } from '@raag/domain';
import { packageName as logging } from '@raag/logging';
import { packageName as config } from '@raag/config';

export const packageName = '@raag/application' as const;
export const builtOn = [domain, logging, config] as const;
