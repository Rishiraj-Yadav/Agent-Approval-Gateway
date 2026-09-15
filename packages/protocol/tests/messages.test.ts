import { describe, expect, it } from 'vitest';
import {
  buildSubmitMessage,
  parseMessage,
  serializeMessage,
  PROTOCOL_VERSION,
  type SubmitMessage,
} from '@raag/protocol';

const SUBMIT: SubmitMessage = {
  v: PROTOCOL_VERSION,
  kind: 'submit',
  requestId: 'req-01',
  correlationId: 'toolu-01',
  machineId: 'mach-1',
  projectId: 'proj-1',
  sessionId: 'sess-1',
  agent: { kind: 'claude-code', version: '2.0' },
  action: {
    tool: 'Bash',
    displaySummary: 'run: npm test',
    payloadSha256: 'a'.repeat(64),
    payloadBytes: 40,
  },
  risk: 'low',
  requestedAtMs: 1_700_000_000_000,
  ttlSeconds: 120,
};

const clone = <T>(v: T): T => structuredClone(v);
function withExtra(input: object, field: string, value: unknown): Record<string, unknown> {
  const c: Record<string, unknown> = { ...clone(input) };
  c[field] = value;
  return c;
}
function withoutField(input: object, field: string): Record<string, unknown> {
  const c: Record<string, unknown> = { ...clone(input) };
  delete c[field];
  return c;
}

describe('submit wire messages', () => {
  it('parse accepts its own serialize and preserves identity + correlation', () => {
    const wire: unknown = JSON.parse(serializeMessage(SUBMIT));
    const parsed = parseMessage(wire);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(`parse rejected its own serialize: ${parsed.reason}`);
    }
    expect(parsed.message).toEqual(SUBMIT);
    if (parsed.message.kind === 'submit') {
      expect(parsed.message.correlationId).toBe('toolu-01');
    } else {
      throw new Error('expected submit kind');
    }
  });

  it('build helper stamps the envelope', () => {
    const { v: _v, kind: _k, ...fields } = SUBMIT;
    void _v;
    void _k;
    const m = buildSubmitMessage(fields);
    expect(m.v).toBe(PROTOCOL_VERSION);
    expect(m.kind).toBe('submit');
    expect(m.requestId).toBe('req-01');
  });
});

describe('untrusted input handling (fail closed)', () => {
  const cases: Array<[string, unknown]> = [
    ['null', null],
    ['array', []],
    ['wrong version', withExtra(SUBMIT, 'v', 'raag.v2')],
    ['unknown kind', withExtra(SUBMIT, 'kind', 'exec')],
    ['extra field', withExtra(SUBMIT, 'evil', 'x')],
    ['missing field', withoutField(SUBMIT, 'requestedAtMs')],
    ['hostile id', withExtra(SUBMIT, 'requestId', '$(reboot server)')],
    [
      'oversized summary',
      { ...clone(SUBMIT), action: { ...SUBMIT.action, displaySummary: 'x'.repeat(4000) } },
    ],
    ['non-hex hash', { ...clone(SUBMIT), action: { ...SUBMIT.action, payloadSha256: 'ZZ' } }],
    ['negative bytes', { ...clone(SUBMIT), action: { ...SUBMIT.action, payloadBytes: -1 } }],
    ['ttl overflow', { ...clone(SUBMIT), ttlSeconds: 99_999 }],
    ['ttl zero', { ...clone(SUBMIT), ttlSeconds: 0 }],
    ['unknown risk', { ...clone(SUBMIT), risk: 'catastrophic' }],
    [
      'control-char summary',
      { ...clone(SUBMIT), action: { ...SUBMIT.action, displaySummary: 'a\u0001b' } },
    ],
    ['extra action key', { ...clone(SUBMIT), action: { ...SUBMIT.action, shell: 'rm -rf' } }],
    [
      '__proto__ key',
      JSON.parse(
        '{"v":"raag.v1","kind":"reject","requestId":"r1","reasonCode":"x-1","__proto__":{"a":1}}',
      ),
    ],
  ];

  for (const [name, input] of cases) {
    it(`rejects ${name}`, () => {
      const r = parseMessage(input);
      expect(r.ok, name).toBe(false);
    });
  }

  it('decision message round-trips opaque token + correlation unchanged', () => {
    const d = {
      v: PROTOCOL_VERSION,
      kind: 'decision',
      requestId: 'req-01',
      correlationId: 'toolu-01',
      decision: 'deny',
      token: 'AbCdEf_123456-ABCDEF',
    } as const;
    const wire: unknown = JSON.parse(JSON.stringify(d));
    const r = parseMessage(wire);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toEqual(d);
  });

  it('decision rejects executable-content token shapes', () => {
    for (const t of [
      "sh -c 'id'",
      '$(whoami)',
      '../etc/passwd',
      'Bearer abcdef123456',
      'a'.repeat(300),
    ]) {
      const r = parseMessage({
        v: PROTOCOL_VERSION,
        kind: 'decision',
        requestId: 'req-1',
        correlationId: 'corr-1',
        decision: 'deny',
        token: t,
      });
      expect(r.ok, t).toBe(false);
    }
  });

  it('reject messages parse with reason codes only', () => {
    const r = parseMessage({
      v: PROTOCOL_VERSION,
      kind: 'reject',
      requestId: 'req-1',
      reasonCode: 'policy-denied',
    });
    if (!r.ok) throw new Error(r.reason);
    if (r.message.kind !== 'reject') {
      throw new Error('expected reject kind');
    }
    expect(r.message.reasonCode).toBe('policy-denied');
  });
});
