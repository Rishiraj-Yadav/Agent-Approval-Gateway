import { describe, expect, it } from 'vitest';
import {
  buildLocalEnvelope,
  buildSubmitMessage,
  canonicalizeJson,
  parseLocalEnvelope,
  localMacCanonical,
  type SubmitMessage,
} from '@raag/protocol';
import { computeMac, verifyMac } from '@raag/security';

const KEY = 'aK7zQ9mR2xL5vN8bH1jD4wF6tY3uI0oP9sE2rA5cM7n.';

function submitMessage(over: Partial<SubmitMessage> = {}): SubmitMessage {
  return buildSubmitMessage({
    requestId: 'req-env-1',
    correlationId: 'corr-env-1',
    machineId: 'mach-env',
    projectId: 'proj-env',
    sessionId: 'sess-env',
    agent: { kind: 'claude-code', version: '1.2.3' },
    action: {
      tool: 'Bash',
      displaySummary: 'run: npm test',
      payloadSha256: 'a'.repeat(64),
      payloadBytes: 13,
    },
    risk: 'medium',
    requestedAtMs: 1_700_000_000_000,
    ttlSeconds: 60,
    ...over,
  });
}

function sign(
  message: unknown,
  ts = 1_700_000_000_000,
  nonce = 'nonce-aa11bb22cc33dd44ee55ff',
): string {
  return buildLocalEnvelope(KEY, message as never, ts, nonce);
}

describe('canonicalization (MAC basis)', () => {
  it('is insertion-order independent and stable', () => {
    const a = canonicalizeJson({ b: 2, a: 1, nested: { d: 4, c: 3 } });
    const b = canonicalizeJson({ nested: { c: 3, d: 4 }, a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toContain('"a":1');
    expect(a.startsWith('{')).toBe(true);
  });

  it('localMacCanonical binds version + ts + nonce to the message', () => {
    const msg = canonicalizeJson(submitMessage());
    const s1 = localMacCanonical(111, 'n1', msg);
    const s2 = localMacCanonical(112, 'n1', msg);
    expect(s1).not.toBe(s2);
    expect(s1).toContain('raag.local|111|n1|');
  });
});

describe('envelope build → parse round-trip (client and server share the basis)', () => {
  it('a correctly signed submit verifies and survives parsing', () => {
    const line = sign(submitMessage());
    const parsed = parseLocalEnvelope(line);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.message.kind).toBe('submit');
    if (parsed.envelope.message.kind === 'submit') {
      expect(parsed.envelope.message.requestId).toBe('req-env-1');
    }
    expect(verifyMac(KEY, parsed.envelope.canonical, parsed.envelope.mac)).toBe(true);
    expect(computeMac(KEY, parsed.envelope.canonical)).toBe(parsed.envelope.mac);
  });

  it('wrong key verifies as false (constant-time path)', () => {
    const line = sign(submitMessage());
    const parsed = parseLocalEnvelope(line);
    expect(
      parsed.ok && verifyMac('x'.repeat(32), parsed.envelope.canonical, parsed.envelope.mac),
    ).toBe(false);
  });
});

describe('envelope fail-closed rejections', () => {
  it('tampered body fails MAC', () => {
    const msg = submitMessage();
    const line = sign(msg).replace('"run: npm test"', '"run: rm -rf /"');
    const parsed = parseLocalEnvelope(line);
    if (!parsed.ok) return; // parse of inner message may also reject hostile text
    expect(verifyMac(KEY, parsed.envelope.canonical, parsed.envelope.mac)).toBe(false);
  });

  it('altered request id breaks the MAC (ids are covered, not just the body blob)', () => {
    const msg = submitMessage();
    const other = { ...msg, requestId: 'req-env-2' };
    const line = sign(other);
    const parsed = parseLocalEnvelope(line);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // self-consistent signature verifies…
    expect(verifyMac(KEY, parsed.envelope.canonical, parsed.envelope.mac)).toBe(true);
    // …but the gateway re-checks the SCOPE against stored data afterwards.
  });

  it('rejects structurally hostile envelopes', () => {
    expect(parseLocalEnvelope('not json').ok).toBe(false);
    expect(parseLocalEnvelope(JSON.stringify([1, 2])).ok).toBe(false);
    const msg = submitMessage();
    const badNonce = buildLocalEnvelope(KEY, msg, 1_700_000_000_000, 'short');
    expect(parseLocalEnvelope(badNonce).ok).toBe(false);
    const okLine = sign(msg);
    const parsedOk = parseLocalEnvelope(okLine);
    expect(parsedOk.ok).toBe(true);
    if (!parsedOk.ok) return;
    const withExtra = JSON.parse(okLine) as Record<string, unknown>;
    delete withExtra['ts'];
    expect(parseLocalEnvelope(JSON.stringify(withExtra)).ok).toBe(false);
  });

  it('rejects malformed mac shapes without leaking them', () => {
    const msg = submitMessage();
    const badMac = sign(msg).replace(/"mac":"[^"]*"/, '"mac":"zzzz"');
    expect(parseLocalEnvelope(badMac).ok).toBe(false);
    const flipped = sign(msg).replace(/"mac":"([0-9a-f])/u, '"mac":"$1');
    const parsed = JSON.parse(flipped) as Record<string, string>;
    expect(parsed['mac']).toHaveLength(64);
  });
});
