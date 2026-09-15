import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * ADR-034 IPC endpoint derivation. Windows named pipes live in the
 * per-session `\\.\pipe\` namespace with default creator-owner ACLs;
 * POSIX sockets land in TMPDIR and are chmod 0600 immediately after bind
 * (plus the directory is sticky). No network port is involved at all.
 * The user segment prevents multi-user collisions on shared machines;
 * it is NOT a security boundary (§3 of the security notes: authenticated
 * frames require the local key regardless of endpoint guessability).
 */
export function defaultIpcPath(platform: NodeJS.Platform, userName: string | undefined): string {
  const user = (userName ?? 'raag').replace(/[^A-Za-z0-9._-]/g, '_');
  if (platform === 'win32') return `\\\\.\\pipe\\raag-${user}`;
  return join(tmpdir(), `raag-${user}.sock`);
}
