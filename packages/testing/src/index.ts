/**
 * @raag/testing — Shared test harness (ADR-015): deterministic fake clock,
 * fixed id generator, collecting audit sink, domain-object fixtures, and the
 * repository conformance suite every approval-store implementation must pass.
 *
 * This is the ONLY package allowed to import the test framework.
 */
export { workspaceManifests, readJson, type PackageJson } from './repo.js';
export * from './harness.js';
export { runRepositoryConformance } from './repository-conformance.js';
export const packageName = '@raag/testing' as const;
