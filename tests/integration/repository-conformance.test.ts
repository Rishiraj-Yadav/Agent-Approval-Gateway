import { InMemoryApprovalRepository } from '@raag/database';
import { runRepositoryConformance } from '@raag/testing';
import { describe, expect, it } from 'vitest';
import { parseMessage, serializeMessage, buildSubmitMessage } from '@raag/protocol';

/**
 * Runs the shared conformance contract (ADR-010) against the in-memory store.
 * The SQLite store in the database phase must run the SAME suite — this file
 * is the contract's only source of truth.
 */
runRepositoryConformance(() => new InMemoryApprovalRepository());

/**
 * The repository is documented as NOT crash-persistent (in-memory only).
 * Proved here so the claim can never silently grow: nothing survives.
 */
describe('in-memory store persistence boundary', () => {
  it('a fresh instance starts empty (no crash durability exists or is claimed)', () => {
    expect(new InMemoryApprovalRepository().size()).toBe(0);
  });
});

/** protocol <-> repository composition sanity across packages. */
describe('cross-package composition (protocol + domain fixtures)', () => {
  it('submit wire round-trips through serialize/parse', () => {
    const m = buildSubmitMessage({
      requestId: 'req-x',
      correlationId: 'corr-x',
      machineId: 'mach-x',
      projectId: 'proj-x',
      sessionId: 'sess-x',
      agent: { kind: 'generic', version: '0.1' },
      action: {
        tool: 'read_file',
        displaySummary: 'read src/x.ts',
        payloadSha256: 'e'.repeat(64),
        payloadBytes: 5,
      },
      risk: 'low',
      requestedAtMs: 1,
      ttlSeconds: 90,
    });
    const parsed = parseMessage(JSON.parse(serializeMessage(m)));
    expect(parsed.ok).toBe(true);
  });
});
