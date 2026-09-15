import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { defaultIpcPath } from '@raag/local-gateway';

describe('defaultIpcPath (ADR-034 endpoint derivation)', () => {
  it('windows: named pipe in the pipe namespace, sanitized user', () => {
    const p = defaultIpcPath('win32', 'RITES h\\bad*name');
    expect(p.startsWith('\\\\.\\pipe\\raag-')).toBe(true);
    expect(p).not.toContain(' ');
    expect(p).not.toContain('bad*');
    expect(p).not.toContain('*');
  });

  it('posix: unix socket in the temp dir, per-user, sanitized', () => {
    const p = defaultIpcPath('linux', "who'ev er");
    expect(p.startsWith(tmpdir())).toBe(true);
    expect(p).toContain('raag-');
    expect(p.endsWith('.sock')).toBe(true);
    expect(p).not.toContain("'");
    expect(p).not.toContain(' ');
  });

  it('missing user falls back to a stable service name', () => {
    expect(defaultIpcPath('win32', undefined).length).toBeGreaterThan(12);
  });
});
