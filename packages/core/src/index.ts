/**
 * @raag/core — Facade barrel over domain + application — the stable import target for apps; apps never import domain/application/ports individually once the facade exists.
 *
 * Phase 1 scaffold: placeholders only. Implementation per
 * docs/architecture.md lands in Phase 2+.
 */
import * as domain from '@raag/domain';
import * as application from '@raag/application';

export const packageName = '@raag/core' as const;
export const layers = { domain, application } as const;
