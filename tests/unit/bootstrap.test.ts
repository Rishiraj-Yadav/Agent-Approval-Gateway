import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJson, workspaceManifests, type PackageJson } from '@raag/testing';

const ROOT = join(import.meta.dirname, '..', '..');
const workspacePkgs = [
  ...workspaceManifests(join(ROOT, 'packages')),
  ...workspaceManifests(join(ROOT, 'apps')),
];

function pkgAt(rel: string): PackageJson {
  const p = join(ROOT, rel, 'package.json');
  expect(existsSync(p), p).toBe(true);
  return readJson<PackageJson>(p);
}

describe('workspace graph', () => {
  it('every workspace package is on @raag, private, ESM, versioned', () => {
    expect(workspacePkgs.length).toBeGreaterThanOrEqual(20);
    for (const path of workspacePkgs) {
      const pkg = readJson<PackageJson>(path);
      expect(pkg.name, path).toMatch(/^@raag\/[a-z0-9-]+$/);
      expect(pkg.private, path).toBe(true);
      expect(pkg.type, path).toBe('module');
      expect(pkg.version, path).toBe('0.0.0');
    }
  });

  it('root manifest declares the workspaces glob and core scripts', () => {
    const root = pkgAt('.') as PackageJson & { engines: { node: string } };
    expect(root.workspaces).toEqual(
      expect.arrayContaining(['packages/*', 'packages/adapters/*', 'apps/*']),
    );
    expect(root.engines.node).toBe('>=22.0.0');
    for (const script of ['build', 'typecheck', 'lint', 'format', 'test']) {
      expect(root.scripts?.[script], script).toBeTruthy();
    }
  });

  it('no package pulls in external runtime dependencies (ADR-017)', () => {
    for (const path of workspacePkgs) {
      const pkg = readJson<PackageJson>(path);
      for (const dep of Object.keys(pkg.dependencies ?? {})) {
        expect(dep, `${String(pkg.name)} -> ${dep}`).toMatch(/^@raag\//);
      }
    }
  });

  it('every project extends the strict base and keeps reference paths valid', () => {
    for (const path of workspacePkgs) {
      const dir = join(path, '..');
      const tsconfigPath = join(dir, 'tsconfig.json');
      expect(existsSync(tsconfigPath), tsconfigPath).toBe(true);
      const ts = readJson<{ extends?: string; references?: { path: string }[] }>(tsconfigPath);
      expect(ts.extends?.endsWith('tsconfig.base.json'), tsconfigPath).toBe(true);
      for (const ref of ts.references ?? []) {
        expect(existsSync(join(dir, ref.path, 'tsconfig.json')), `${path} -> ${ref.path}`).toBe(
          true,
        );
      }
    }
  });
});

describe('tsconfig strictness', () => {
  const base = readJson<{ compilerOptions: Record<string, unknown> }>(
    join(ROOT, 'tsconfig.base.json'),
  );

  it('enables the security-relevant strict flags', () => {
    for (const flag of [
      'strict',
      'noUncheckedIndexedAccess',
      'exactOptionalPropertyTypes',
      'noFallthroughCasesInSwitch',
      'noImplicitOverride',
      'forceConsistentCasingInFileNames',
      'isolatedModules',
      'verbatimModuleSyntax',
    ] as const) {
      expect(base.compilerOptions[flag], flag).toBe(true);
    }
  });

  it('compiles to modern ESM/NodeNext with project references', () => {
    expect(base.compilerOptions.target).toBe('ES2023');
    expect(base.compilerOptions.module).toBe('NodeNext');
    expect(base.compilerOptions.composite).toBe(true);
  });
});

describe('domain and layer purity (dependency rule, architecture.md §16)', () => {
  function sources(rel: string): string[] {
    const dir = join(ROOT, rel);
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.ts'))
          .map((f) => join(dir, f))
      : [];
  }

  it('domain sources import nothing at all', () => {
    for (const file of sources('packages/domain/src')) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/\bfrom\s+["']/);
    }
  });

  it('core, application, and security never name vendor or process-spawning code', () => {
    for (const rel of ['packages/core/src', 'packages/application/src', 'packages/security/src']) {
      for (const file of sources(rel)) {
        const text = readFileSync(file, 'utf8');
        expect(text, file).not.toMatch(/node:child_process|child_process|grammy|better-sqlite3/);
      }
    }
  });
});
