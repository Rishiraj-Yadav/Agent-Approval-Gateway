/**
 * @raag/generic — Generic HTTP/JSON adapter for agents with no dedicated integration yet — the extension-model proof that a new agent needs no core changes.
 *
 * Phase 1 scaffold: placeholders only. Implementation per
 * docs/architecture.md lands in Phase 2+.
 */
import { packageName as domain } from '@raag/domain';

export const packageName = '@raag/generic' as const;
export const builtOn = domain;
