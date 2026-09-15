import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJson, workspaceManifests, type PackageJson } from '@raag/testing';

const ROOT = join(import.meta.dirname, '..', '..');

describe('secret handling (security.md §4)', () => {
  it('the .env ignore rules are git-ignored and the example negation is intact', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
    expect(ignore).toContain('.env');
    expect(ignore).toContain('.env.*');
    expect(ignore).toContain('!.env.example');
  });

  it('the .env.example carries no committed values and lists the security-relevant keys', () => {
    const lines = readFileSync(join(ROOT, '.env.example'), 'utf8').split(/\r?\n/);
    const assignments = lines.filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l));
    expect(assignments.length).toBeGreaterThanOrEqual(6);
    for (const line of assignments) {
      const value = line.slice(line.indexOf('=') + 1).trim();
      // Only safe, public defaults are allowed; secret-bearing keys must be empty.
      const key = line.slice(0, line.indexOf('='));
      const safeDefaults = new Map([
        ['GATEWAY_HOST', '127.0.0.1'], // loopback-only bind, itself a failing-closed default
        ['APPROVAL_TTL_SECONDS', '120'],
        ['LOG_LEVEL', 'info'],
        ['GATEWAY_DB_PATH', './data/gateway.db'],
        ['GATEWAY_PORT', '0'],
      ]);
      expect(value, `secret-bearing ${key} must ship empty — found "${value}"`).toBe(
        safeDefaults.get(key) ?? '',
      );
    }
    for (const secret of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_CHAT_IDS', 'APPROVAL_HMAC_KEY']) {
      expect(assignments.some((l) => l.startsWith(`${secret}=`))).toBe(true);
    }
  });

  it('no .env (or stray secret file) exists in the working tree', () => {
    const stray = readdirSync(ROOT).filter(
      (f) => f === '.env' || (f.startsWith('.env.') && f !== '.env.example'),
    );
    expect(stray).toEqual([]);
  });
});

describe('no execution primitive reachable from foundation code (ADR-004)', () => {
  const sources = [
    ...workspaceManifests(join(ROOT, 'packages')),
    ...workspaceManifests(join(ROOT, 'apps')),
  ]
    .map((p) => join(p, '..', 'src'))
    .filter((d) => existsSync(d))
    .flatMap((d) =>
      readdirSync(d)
        .filter((f) => f.endsWith('.ts'))
        .map((f) => join(d, f)),
    );

  it('child_process / worker_threads / vm appear in no package source', () => {
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(
        /node:(child_process|worker_threads|vm)\b|\b(child_process|Worker)\b/,
      );
    }
  });

  it('no package (packages/) defines any listener of any kind', () => {
    for (const file of sources.filter((f) => f.startsWith(join(ROOT, 'packages')))) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\bcreateServer\b|\bserve\s*\(|\.listen\s*\(/);
    }
  });

  it('the ONLY listener in the repo is the local gateway, and it is IPC-path-only (ADR-034)', () => {
    const gatewayDir = join(ROOT, 'apps', 'local-gateway', 'src');
    expect(existsSync(gatewayDir), 'gateway sources must exist').toBe(true);
    const gatewayFiles = readdirSync(gatewayDir).filter((f) => f.endsWith('.ts'));
    for (const f of gatewayFiles) {
      const file = join(gatewayDir, f);
      const text = readFileSync(file, 'utf8');
      // node:http (TCP/HTTP) is forbidden everywhere in the gateway…
      expect(text, file).not.toMatch(/node:http|require\(['"]http/);
      // …and no numeric listen-port argument pattern may appear
      expect(text, file).not.toMatch(/\.listen\s*\(\s*\d+|listen\s*\(\s*port|host:|hostname:/i);
      // wildcard bind literals forbidden (config validation does the work)
      expect(text, file).not.toContain('0.0.0.0');
    }
    // the server module must exist and bind exclusively via { path }
    const ipc = readFileSync(join(gatewayDir, 'ipc-server.ts'), 'utf8');
    expect(ipc).toMatch(/server\.listen\(\{\s*path/);
  });
});

describe('package hygiene', () => {
  const workspacePkgs = [
    ...workspaceManifests(join(ROOT, 'packages')),
    ...workspaceManifests(join(ROOT, 'apps')),
  ];

  it('no lifecycle scripts that could run arbitrary code on install', () => {
    for (const path of workspacePkgs) {
      const pkg = readJson<PackageJson & { scripts?: Record<string, string> }>(path);
      for (const risky of ['preinstall', 'postinstall', 'prepare', 'install']) {
        expect(pkg.scripts?.[risky], `${String(pkg.name)}: ${risky}`).toBeUndefined();
      }
    }
  });

  it('every published-shaped manifest keeps dist out of version control', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^\s*dist\/\s*$/m);
    expect(ignore).toContain('node_modules/');
  });
});
