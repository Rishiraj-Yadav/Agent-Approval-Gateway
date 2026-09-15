import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Manifest shape used by foundation tests (structural, permissive enough). */
export interface PackageJson {
  name: string;
  version?: string;
  private?: boolean;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[];
  exports?: Record<string, { types?: string; default?: string }>;
}

export function projectRoot(): string {
  return resolve(import.meta.dirname, '..', '..', '..', '..');
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** All workspace package.json paths under a directory (incl. packages/adapters/*). */
export function workspaceManifests(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    const manifest = join(child, 'package.json');
    if (existsSync(manifest)) out.push(manifest);
    out.push(...(entry.name === 'adapters' ? workspaceManifests(child) : []));
  }
  return out;
}
