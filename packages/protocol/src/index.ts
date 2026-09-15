/**
 * @raag/protocol — Wire-level DTOs for adapter↔gateway (loopback) and gateway↔relay message frames. Keeps domain types out of serialized surfaces.
 *
 * Phase 1 scaffold: placeholders only. Implementation per
 * docs/architecture.md lands in Phase 2+.
 */
import { packageName as domain } from '@raag/domain';

export const packageName = '@raag/protocol' as const;
export const builtOn = domain;
