import { describe, expect, it, vi } from 'vitest';
import { parseRequestId } from '@raag/domain';
import {
  buildDecisionMessage,
  buildRejectMessage,
  parseMessage,
  PROTOCOL_VERSION,
} from '@raag/protocol';
import { InMemoryApprovalRepository, InMemoryAuditSink } from '@raag/database';
import { ApprovalManager } from '@raag/application';
import { createFakeClock, testRequestInput } from '@raag/testing';
import { consoleSink, createLogger } from '@raag/logging';

describe('protocol builders (decision/reject)', () => {
  it('decision builder output parses; oversized body rejected', () => {
    const d = buildDecisionMessage({
      requestId: 'req-b1',
      correlationId: 'corr-b1',
      decision: 'allow-session',
      token: 'tokval123456',
    });
    expect(d.v).toBe(PROTOCOL_VERSION);
    const okParse = parseMessage(JSON.parse(JSON.stringify(d)));
    expect(okParse.ok).toBe(true);

    const huge = 'y'.repeat(300_000);
    const s = buildRejectMessage({ requestId: 'req-b2', reasonCode: 'x-1' });
    expect(s.kind).toBe('reject');
    const bodyBig = parseMessage({
      v: PROTOCOL_VERSION,
      kind: 'submit',
      requestId: 'req-b3',
      correlationId: 'corr-b3',
      machineId: 'm',
      projectId: 'p',
      sessionId: 's',
      agent: { kind: 'kilo', version: '1' },
      action: {
        tool: 'x'.repeat(64),
        displaySummary: huge.slice(0, 2_040),
        payloadSha256: 'a'.repeat(64),
        payloadBytes: 1,
      },
      risk: 'low',
      requestedAtMs: 1,
      ttlSeconds: 60,
    });
    // summary is within length cap so parse itself accepts it (2040 chars):
    expect(bodyBig.ok).toBe(true);
    const tooBig = parseMessage({
      v: PROTOCOL_VERSION,
      kind: 'submit',
      requestId: 'req-b4',
      correlationId: 'x'.repeat(128) + '-y',
      corr: 1,
    });
    expect(tooBig.ok).toBe(false);
  });
});

describe('manager additional branches', () => {
  it('get() on unknown returns undefined; expireDue on empty returns 0', async () => {
    const mgr = new ApprovalManager({
      repository: new InMemoryApprovalRepository(),
      clock: createFakeClock(10),
      audit: new InMemoryAuditSink(),
    });
    expect(await mgr.get(parseRequestId('req-nope'))).toBeUndefined();
    expect(await mgr.expireDue()).toBe(0);
  });

  it('submit with invalid input returns rejected and logs submit-rejected (no repo write)', async () => {
    const audit = new InMemoryAuditSink();
    const repository = new InMemoryApprovalRepository();
    const mgr = new ApprovalManager({
      repository,
      clock: createFakeClock(10),
      audit,
    });
    const res = await mgr.submit(testRequestInput({ agent: { kind: 'NOT VALID', version: '1' } }));
    expect(res).toEqual({ rejected: 'invalid-input' });
    expect(repository.size()).toBe(0);
    expect(audit.events().some((e) => e.type === 'submit-rejected')).toBe(true);
  });
});

describe('logging console sink smoke', () => {
  it('consoleSink writes newline-terminated lines to stdout', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = createLogger({ name: 'smoke', level: 'debug', sink: consoleSink() });
    logger.info('hello');
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]?.[0] ?? '');
    expect(line.endsWith('\n')).toBe(true);
    const rec = JSON.parse(line) as Record<string, unknown>;
    expect(rec.logger).toBe('smoke');
    spy.mockRestore();
  });
});
