/**
 * @raag/testing — Shared test harness: fixed Clock, fakes for ports,
 * in-memory transports, and repo-introspection helpers used by the
 * foundation tier. Test-facing public API only.
 */
import { packageName as domainPkg } from '@raag/domain';
import { packageName as loggingPkg } from '@raag/logging';

export const packageName = '@raag/testing' as const;
export const builtOn = [domainPkg, loggingPkg] as const;

export * from './repo.js';
