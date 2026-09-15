import { describe, expect, it } from 'vitest';
import {
  NONCE_PATTERN,
  ackFor,
  buildLocalEnvelope,
  buildSubmitMessage,
  canonicalizeJson,
  localMacCanonical,
  parseLocalEnvelope,
  serializeResponse,
} from '@raag/protocol';
import { verifyMac } from '@raag/security';

const KEY = 'mac-key-0123456789abcdefABCDEF012345';
const TS = 1_700_000_000_000;

const msg = buildSubmitMessage({
  requestId: 'req-env-1',
  correlationId: 'corr-env-1',
  machineId: 'mach-env',
  projectId: 'proj-env',
  sessionId: 'sess-env',
  agent: { kind: 'claude-code', version: '1.0.0' },
  action: {
    tool: 'Bash',
    displaySummary: 'run: make check',
    payloadSha256: 'd'.repeat(64),
    payloadBytes: 13,
  },
  risk: 'medium',
  requestedAtMs: TS,
  ttlSeconds: 90,
});

describe('canonicalizeJson (MAC basis)', () => {
  it('sorts keys deterministically at every depth', () => {
    const a = { z: 1, a: { n: 2, b: [3, { y: 4, x: 5 }] } };
    const b = { a: { b: [3, { x: 5, y: 4 }], n: 2 }, z: 1 };
    expect(canonicalizeJson(a)).toBe(canonicalizeJson(b));
    expect(canonicalizeJson(a)).not.toContain(' ');
  });

  it('stringifies bigints as decimal and maps exotic values stably', () => {
    expect(canonicalizeJson({ big: 12345678901234n, u: undefined, s: Symbol('x') })).toBe(
      '{"big":"12345678901234","s":null,"u":null}',
    );
  });

  it('drops dangerous object-prototype keys from the canonical form', () => {
    const proto = JSON.parse('{"__proto__":{"injected":true},"ok":1}') as Record<string, unknown>;
    const canon = canonicalizeJson(proto);
    expect(canon).not.toContain('__proto__');
    expect(canon).not.toContain('prototype');
    expect(canon).not.toContain('constructor');
    expect(canon).toContain('"ok":1');
    expect(({} as Record<string, unknown>)['injected']).toBeUndefined();
  });

  it('rejects non-finite numbers (they are not serializable input)', () => {
    expect(() => canonicalizeJson({ n: Number.NaN })).toThrowError(/non-finite|NaN|Infinity/i);
  });

  it('caps nesting depth (no recursion bombs on hostile nesting)', () => {
    let deep: Record<string, unknown> = { end: 1 };
    for (let i = 0; i < 40; i++) deep = { under: deep };
    expect(() => canonicalizeJson(deep)).toThrowError(/depth/i);
  });
});

describe('localMacCanonical', () => {
  it('binds ts+nonce+message (all three vary the digest)', () => {
    const base = canonicalizeJson(msg);
    const a = localMacCanonical(TS, 'n1', base);
    expect(a).not.toBe(localMacCanonical(TS, 'n2', base));
    expect(a).not.toBe(localMacCanonical(TS - 1, 'n1', base));
    expect(a).not.toBe(localMacCanonical(TS, 'n1', base + '.'));
    expect(a).toContain('raag.local|');
  });
});

describe('parseLocalEnvelope', () => {
  const good = buildLocalEnvelope(KEY, msg, TS, 'valid-nonce-aaaa1111bbbb');

  it('round-trips a signed envelope and exposes the canonical for verifyMac', () => {
    const r = parseLocalEnvelope(good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.envelope.message.kind).toBe('submit');
    expect(verifyMac(KEY, r.envelope.canonical, r.envelope.mac)).toBe(true);
    expect(
      verifyMac('a-totally-different-key-aaaaaaaaaaaaa', r.envelope.canonical, r.envelope.mac),
    ).toBe(false);
  });

  it('rejects non-JSON / array / null / extra-key / bad-version / bad-ts / bad-nonce-shape / bad-mac-shape', () => {
    const rejectReasons = (line: string): string => {
      const r = parseLocalEnvelope(line);
      return r.ok ? 'ACCEPTED?!' : r.reason;
    };
    expect(rejectReasons('nope')).toMatch(/json|parse/i);
    expect(rejectReasons('[]')).toMatch(/object|array/i);
    expect(rejectReasons('null')).toMatch(/json|object/i);
    const goodObj = JSON.parse(good) as Record<string, unknown>;
    expect(rejectReasons(JSON.stringify({ ...goodObj, v1: 'raag.v9' }))).toMatch(/exact|field/i);
    expect(rejectReasons(JSON.stringify({ ...goodObj, v: 'raag.v9' }))).toMatch(/version/i);
    expect(rejectReasons(JSON.stringify({ ...goodObj, ts: 0 }))).toMatch(/timestamp/i);
    expect(rejectReasons(JSON.stringify({ ...goodObj, ts: 1.5 }))).toMatch(/timestamp/i);
    expect(rejectReasons(JSON.stringify({ ...goodObj, nonce: '-starts-bad' }))).toMatch(/nonce/i);
    expect(rejectReasons(JSON.stringify({ ...goodObj, nonce: 'short' }))).toMatch(/nonce/i);
    expect(
      rejectReasons(JSON.stringify({ ...goodObj, mac: 'zz'.repeat(16).slice(0, 32) })),
    ).toMatch(/mac/i);
    // correct-shape-but-wrong mac passes PARSE (verification is verifyMac's job)
    expect(parseLocalEnvelope(JSON.stringify({ ...goodObj, mac: '0'.repeat(64) })).ok).toBe(true);
  });

  it('the nonce gate is exactly NONCE_PATTERN (alnum start, 16-128 total)', () => {
    expect(NONCE_PATTERN.test('a'.repeat(16))).toBe(true);
    expect(NONCE_PATTERN.test('a'.repeat(128))).toBe(true);
    expect(NONCE_PATTERN.test('a'.repeat(15))).toBe(false);
    expect(NONCE_PATTERN.test('a'.repeat(129))).toBe(false);
    expect(NONCE_PATTERN.test('-a'.repeat(9))).toBe(false);
    expect(NONCE_PATTERN.test('has space-inside')).toBe(false);
  });

  it('rejects envelopes whose inner message is invalid', () => {
    const broken = JSON.parse(good) as Record<string, unknown>;
    broken['message'] = { v: 'raag.v1', kind: 'submit', requestId: 'bad id!!' };
    expect(parseLocalEnvelope(JSON.stringify(broken)).ok).toBe(false);
  });

  it('rejects a message whose shape is invalid even when signed correctly', () => {
    const bogus = {
      v: 'raag.v1',
      kind: 'submit',
      ...(Object.freeze({ requestId: 1, nested: 'nope' }) as unknown as Record<string, string>),
    } as never;
    const line = buildLocalEnvelope(KEY, bogus, TS, 'depth-nonce-aaaa0000');
    expect(parseLocalEnvelope(line).ok).toBe(false);
  });
});

describe('response frames', () => {
  it('ackFor carries identity + safe metadata', () => {
    const a = ackFor({
      requestId: 'r-1',
      correlationId: 'c-1',
      state: 'approved',
      version: 3,
      expiresAt: 999,
      decision: { kind: 'allow-session' },
    });
    expect(a).toMatchObject({
      kind: 'ack',
      requestId: 'r-1',
      state: 'approved',
      revision: 3,
      decisionKind: 'allow-session',
    });
    const b = ackFor({
      requestId: 'r-2',
      correlationId: 'c-2',
      state: 'failed',
      version: 1,
      expiresAt: 50,
      failureCode: 'audit-failure',
    });
    expect(b['decisionKind']).toBeUndefined();
    expect(b.failureCode).toBe('audit-failure');
  });

  it('serializeResponse is newline-terminated (NDJSON)', () => {
    const line = serializeResponse({ kind: 'error', v: 'raag.v1', reasonCode: 'shutdown' });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ kind: 'error', reasonCode: 'shutdown' });
  });
});
