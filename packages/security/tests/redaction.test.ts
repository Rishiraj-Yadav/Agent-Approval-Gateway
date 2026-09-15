import { describe, expect, it } from 'vitest';
import { REDACTED, isSensitiveFieldName, redactString, redactUnknown } from '@raag/security';

const SECRETISH = [
  // OpenAI-style key (long base64-ish rule)
  'sk-proj-ABCabc123ABCabc123ABCabc123ABCabc123ABCabc123ABCabc',
  // AWS access key id + secret pair
  'AKIAABCDEFGHIJKLMNOP',
  'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  // generic bearer
  'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  // Telegram bot token
  'TELEGRAM_BOT_TOKEN=8123456789:AAH1qExampleTokenExample1234567890abcdef',
  // quoted JSON secret
  '{"password": "hunter2CorrectHorse", "token":"eyJdead.beef.cafe"}',
  // env dump style
  'APPROVAL_HMAC_KEY=0123456789abcdef0123456789abcdef0123456789abcdef\nPATH=/usr/bin',
];

describe('redactString', () => {
  it.each(SECRETISH)('scrubs %s', (input) => {
    const out = redactString(input);
    expect(out).not.toBe(input);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('ABCabc');
    expect(out).not.toContain('wJalr');
    expect(out).not.toContain('dozjgNry');
    expect(out).not.toContain('AAH1q');
    // visible safe residue only — key NAMES may remain, values must not
  });

  it('keeps safe text untouched', () => {
    const safe = 'npm run build passed (NodeNext module, 34 ms)';
    expect(redactString(safe)).toBe(safe);
  });

  it('keeps authorization label, drops the value', () => {
    const out = redactString('Authorization: Basic dXNlcjpwYXNzMTIzNDU2Nzg5MDEyMzQ1Ng==');
    expect(out).toMatch(/^authorization:\s/i);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('dXNlcj');
  });

  it('bearer scheme word survives, token does not', () => {
    const out = redactString('Send Bearer abcdefghijklmnop123456 now');
    expect(out.toLowerCase()).toContain('bearer');
    expect(out).toBe(`Send Bearer ${REDACTED} now`);
  });

  it('is idempotent and deterministic on hostile samples', () => {
    for (const sample of [...SECRETISH, 'no secrets here', '', 'a'.repeat(66_000)]) {
      const once = redactString(sample);
      expect(redactString(once)).toBe(once);
      expect(redactString(once)).toBe(redactString(sample)); // deterministic
    }
  });

  it('clips oversized input instead of dumping it fully', () => {
    const out = redactString('x'.repeat(70_000));
    expect(out).toContain('[truncated]');
    expect(out.length).toBeLessThan(70_010);
  });
});

describe('redactUnknown (nested untrusted data)', () => {
  it('replaces whole values of sensitive keys at any depth', () => {
    const out = redactUnknown({
      env: { TELEGRAM_BOT_TOKEN: '8123456789:AAExampleTokenHere1234567890abcdef', HOME: '/x' },
      headers: { Authorization: 'Bearer abcdefghijklmnop12' },
      nested: [{ creds: 'user:pass' }, { password: 'hunter2' }],
    }) as Record<string, Record<string, unknown>>;
    expect(out['env']?.['TELEGRAM_BOT_TOKEN']).toBe(REDACTED);
    expect(out['env']?.['HOME']).toBe('/x');
    expect(out['headers']?.['Authorization']).toContain(REDACTED);
    expect(out['headers']?.['Authorization'] as string).not.toContain('abcdefghijklmn');
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('survives hostile shapes: cycles, deep nesting, huge arrays, functions', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    const deep = (() => {
      let obj: Record<string, unknown> = { terminal: 'z'.repeat(50) };
      for (let i = 0; i < 30; i++) obj = { child: obj };
      return obj;
    })();
    const out = redactUnknown([cyclic, deep, new Uint8Array(10), () => 1, Symbol('s')]);
    expect(() => JSON.stringify(out)).not.toThrow();
    const text = JSON.stringify(out);
    expect(text).toContain('[cycle]');
    expect(text).toContain('[depth-limit]');
    expect(text).toContain('[binary:10]');
    expect(text).toContain('[function]');
  });

  it('primitives of any kind pass through unchanged (except strings)', () => {
    expect(redactUnknown([1, true, null])).toEqual([1, true, null]);
    expect(redactUnknown('')).toBe('');
  });

  it('prototype-polluting keys never ride into output objects', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":"yes"},"token":"abc123456"}') as Record<
      string,
      unknown
    >;
    const out = redactUnknown(hostile) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call({}, 'polluted')).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(out['token']).toBe('[redacted]');
  });
});

describe('isSensitiveFieldName', () => {
  it('classifies known families', () => {
    for (const name of ['API_KEY', 'authorization', 'refreshToken', 'client_secret', 'cookie']) {
      expect(isSensitiveFieldName(name), name).toBe(true);
    }
    for (const name of ['tool', 'displaySummary', 'path']) {
      expect(isSensitiveFieldName(name), name).toBe(false);
    }
  });
});
