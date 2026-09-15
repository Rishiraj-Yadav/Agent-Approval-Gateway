import { describe, expect, it } from 'vitest';
import {
  parseAgentId,
  parseCorrelationId,
  parseMachineId,
  parseProjectId,
  parseRequestId,
  parseSessionId,
} from '@raag/domain';

const VALID = 'req_01J9ZV8H2K7Q4CXM3WTP';

describe('IDs', () => {
  it('accepts well-formed opaque ids', () => {
    expect(parseRequestId(VALID)).toBe(VALID);
    expect(parseCorrelationId('corr.1-2:3')).toBe('corr.1-2:3');
    expect(parseMachineId('MACH-001')).toBe('MACH-001');
    expect(parseSessionId('0192b3f4-7c8d-4e5f-9a0b-1c2d3e4f5a6b')).toBeTypeOf('string');
    expect(parseProjectId('proj_x')).toBe('proj_x');
    expect(parseAgentId('a')).toBe('a');
  });

  it('rejects empty, malformed, oversized, hostile ids', () => {
    const bad = [
      '',
      '  x',
      'x'.repeat(129),
      '../etc',
      'a/b',
      'a\\b',
      'a b',
      'a;b',
      '$(id)',
      'é',
      '❌',
      'a\nb',
    ];
    for (const raw of bad) {
      expect(() => parseRequestId(raw), raw).toThrowError(/invalid-id/);
      expect(() => parseCorrelationId(raw), raw).toThrowError(/invalid-id/);
      expect(() => parseMachineId(raw), raw).toThrowError(/invalid-id/);
    }
    for (const notString of [null, undefined, 42, {}, [], true]) {
      expect(() => parseRequestId(notString)).toThrowError(/invalid-id/);
    }
  });

  it('errors never echo the rejected value', () => {
    const secretish = 'password=hunter2xxxxx';
    try {
      parseRequestId(secretish.split('').reverse().join(''));
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('2retnuh');
      expect(message).toMatch(/invalid-id/);
    }
  });
});
