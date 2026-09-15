import { describe, expect, it } from 'vitest';
import {
  createActionDescriptor,
  createAgentIdentity,
  createApprovalRequest,
  createAuditEvent,
  createMachineIdentity,
  decisionAllows,
  decisionRequestsStop,
  parseDecisionKind,
  parseMillis,
  parsePolicyOutcome,
  parseRiskLevel,
  reviveApprovalRequest,
  riskRank,
  secondsToDuration,
} from '@raag/domain';

const base = () => ({
  requestId: 'req-1',
  correlationId: 'cor-1',
  agent: { kind: 'claude-code', version: '2.0.0' },
  machine: { id: 'mach-1', displayName: 'desk' },
  project: { id: 'proj-1', displayPath: '/home/dev/app' },
  session: { sessionId: 'sess-1' },
  action: {
    tool: 'bash',
    displaySummary: 'run tests',
    payloadSha256: 'd'.repeat(64),
    payloadBytes: 8,
  },
  risk: 'high',
  requestedAt: 1000,
});

describe('risk / decision / policy vocabularies', () => {
  it('risk levels are the exact domain set, ordered', () => {
    expect(['low', 'medium', 'high', 'critical'].map((r) => parseRiskLevel(r))).toEqual([
      'low',
      'medium',
      'high',
      'critical',
    ]);
    expect(riskRank('critical')).toBeGreaterThan(riskRank('low'));
    for (const bad of ['', 'CRITICAL!', 'moderate', 7, null]) {
      expect(() => parseRiskLevel(bad), String(bad)).toThrowError(/invalid-risk/);
    }
  });

  it('decision scopes are not booleans: allow-once vs allow-session differ, stop-agent denies action', () => {
    expect(decisionAllows(parseDecisionKind('allow-once'))).toBe(true);
    expect(decisionAllows(parseDecisionKind('allow-session'))).toBe(true);
    expect(decisionAllows(parseDecisionKind('deny'))).toBe(false);
    expect(decisionAllows(parseDecisionKind('stop-agent'))).toBe(false);
    expect(decisionRequestsStop(parseDecisionKind('stop-agent'))).toBe(true);
    for (const bad of ['allow', 'approve', 'once', '', 'OK']) {
      expect(() => parseDecisionKind(bad), bad).toThrowError(/invalid-decision/);
    }
  });

  it('policy vocabulary parses fail-closed', () => {
    expect(parsePolicyOutcome('need-human')).toBe('need-human');
    for (const bad of ['auto_allow', 'allow', '', null]) {
      expect(() => parsePolicyOutcome(bad), String(bad)).toThrowError(/invalid-policy/);
    }
  });
});

describe('identity & action construction', () => {
  it('known agent kinds pass; future slug kinds pass; garbage fails', () => {
    expect(createAgentIdentity({ kind: 'codex', version: '0.45.0' }).kind).toBe('codex');
    expect(createAgentIdentity({ kind: 'future-agent', version: 'v1' }).kind).toBe('future-agent');
    for (const bad of [
      'Claude Code',
      'UPPER',
      '-lead',
      '',
      'kind_with_underscore',
      'a'.repeat(33),
    ]) {
      expect(() => createAgentIdentity({ kind: bad, version: '1' }), bad).toThrowError(
        /invalid-agent-identity/,
      );
    }
    expect(() => createAgentIdentity({ kind: 'kilo', version: 'v 1' })).toThrowError(
      /invalid-agent-identity/,
    );
  });

  it('display fields default to <unknown> and reject control chars/hostile strings', () => {
    expect(createMachineIdentity({ id: 'm-1' }).displayName).toBe('<unknown>');
    expect(() => createMachineIdentity({ id: 'm-1', displayName: 'a\tb' })).toThrowError();
    expect(() => createMachineIdentity({ id: 'm-1', displayName: '\x1b[31mred' })).toThrowError();
  });

  it('action requires tool shape, sha256, non-negative byte count; displaySummary rejects control chars/overlong', () => {
    expect(() =>
      createActionDescriptor({
        tool: 'run_cmd',
        displaySummary: 'ok',
        payloadSha256: 'A'.repeat(64), // uppercase must be rejected: lowercase hex only
        payloadBytes: 1,
      }),
    ).toThrowError(/invalid-action/);
    expect(() =>
      createActionDescriptor({
        tool: 'run cmd',
        displaySummary: 'ok',
        payloadSha256: 'e'.repeat(64),
        payloadBytes: 1,
      }),
    ).toThrowError(/invalid-action/);
    expect(() =>
      createActionDescriptor({
        tool: 'bash',
        displaySummary: 'x'.repeat(2041),
        payloadSha256: 'e'.repeat(64),
        payloadBytes: 1,
      }),
    ).toThrowError(/invalid-action/);
    expect(() =>
      createActionDescriptor({
        tool: 'bash',
        displaySummary: 'ok',
        payloadSha256: 'e'.repeat(64),
        payloadBytes: -1,
      }),
    ).toThrowError(/invalid-action/);
  });
});

describe('ApprovalRequest', () => {
  it('happy path', () => {
    const r = createApprovalRequest(base());
    expect(r.state).toBe('created');
    expect(r.version).toBe(1);
    expect(r.risk).toBe('high');
    expect(r.requestId).toBe('req-1');
    expect(r.expiresAt).toBe(1000 + 120_000);
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('default TTL is 120s; secondsToDuration caps 1..3600', () => {
    expect(secondsToDuration(1)).toBe(1_000);
    expect(() => secondsToDuration(0)).toThrowError(/invalid-duration/);
    expect(() => secondsToDuration(3601)).toThrowError(/invalid-duration/);
    expect(() => secondsToDuration(1.5)).toThrowError(/invalid-duration/);
  });

  it('rejects invalid ids / missing pieces / non-finite times at the boundary', () => {
    expect(() => createApprovalRequest({ ...base(), requestId: '' })).toThrowError(/invalid-id/);
    expect(() => createApprovalRequest({ ...base(), correlationId: 'bad id' })).toThrowError(
      /invalid-id/,
    );
    expect(() => createApprovalRequest({ ...base(), machine: 'nope' })).toThrowError(
      /invalid-request|invalid-id/,
    );
    expect(() => createApprovalRequest({ ...base(), requestedAt: NaN })).toThrowError(
      /invalid-timestamp/,
    );
    expect(() => createApprovalRequest({ ...base(), risk: 'extreme' })).toThrowError(
      /invalid-risk/,
    );
    expect(() => createApprovalRequest({ ...base(), action: null })).toThrowError(
      /invalid-request|invalid-action/,
    );
  });

  it('revive rejects impossible combos (created with decision) and revalidates', () => {
    const r = createApprovalRequest(base());
    expect(reviveApprovalRequest(r, parseMillis(1_500, 'now')).state).toBe('created');
    expect(() => reviveApprovalRequest(r, undefined)).toThrowError(/invalid-request/);
    expect(() =>
      reviveApprovalRequest(
        {
          ...r,
          state: 'created',
          decision: { kind: 'allow-once', decidedAt: parseMillis(2, 'x') },
        },
        parseMillis(5, 'now'),
      ),
    ).toThrowError();
    expect(() => reviveApprovalRequest({ ...r, version: 0 }, parseMillis(9, 'now'))).toThrowError();
    expect(() =>
      reviveApprovalRequest(
        { ...r, risk: 'nope' } as unknown as import('@raag/domain').ApprovalRequest,
        parseMillis(9, 'now'),
      ),
    ).toThrowError(/invalid-risk/);
  });
});

describe('audit events', () => {
  it('scalar details only; rejects objects and hostile strings', () => {
    const e = createAuditEvent({
      type: 'request-resolved',
      occurredAt: 1234,
      actor: 'manager',
      requestId: 'req-1',
      detail: { 'machine-id': 'm-1', retries: 2, ok: true },
    });
    expect(e.detail.retries).toBe(2);
    expect(() =>
      createAuditEvent({
        type: 'request-created',
        occurredAt: 1,
        actor: 'system',
        detail: { nested: {} },
      }),
    ).toThrowError(/invalid-audit-event/);
    expect(() =>
      createAuditEvent({
        type: 'request-created',
        occurredAt: 1,
        actor: 'system',
        detail: { value: 'passw\u0000rd' },
      }),
    ).toThrowError(/invalid-audit-event/);
    expect(() =>
      createAuditEvent({ type: 'made-up-type', occurredAt: 1, actor: 'system' }),
    ).toThrowError(/invalid-audit-event/);
    expect(() =>
      createAuditEvent({ type: 'request-created', occurredAt: 1, actor: 'hacker' }),
    ).toThrowError(/invalid-audit-event/);
  });
});
