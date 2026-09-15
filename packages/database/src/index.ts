/**
 * @raag/database — persistent-state adapters.
 * Phase 2 ships IN-MEMORY ONLY — explicitly not crash-persistent;
 * SQLite arrives with the storage phase and must pass
 * @raag/testing's conformance suite.
 */
export * from './storage.js';
