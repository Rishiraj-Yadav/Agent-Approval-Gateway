import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJson, workspaceManifests } from '@raag/testing';
import { packageName as adapters } from '@raag/adapters';
import { packageName as application } from '@raag/application';
import { packageName as claudeCode } from '@raag/claude-code';
import { packageName as codex } from '@raag/codex';
import { packageName as config } from '@raag/config';
import { packageName as core } from '@raag/core';
import { packageName as database } from '@raag/database';
import { packageName as domain } from '@raag/domain';
import { packageName as generic } from '@raag/generic';
import { packageName as kiloCode } from '@raag/kilo-code';
import { packageName as logging } from '@raag/logging';
import { packageName as policy } from '@raag/policy';
import { packageName as protocol } from '@raag/protocol';
import { packageName as security } from '@raag/security';
import { packageName as telegram } from '@raag/telegram';
import { packageName as testing } from '@raag/testing';
import { identity as cliIdentity } from '@raag/cli';
import { identity as gatewayIdentity } from '@raag/local-gateway';

const ROOT = join(import.meta.dirname, '..', '..');

/**
 * Exercises the monorepo wiring end-to-end: every package resolves by its
 * manifest name, and the facade/registry barrels import the concrete packages
 * (proving the project-reference graph compiles as wired, not just listed).
 */
describe('workspace package resolution', () => {
  const identities: ReadonlyArray<readonly [string, string]> = [
    ['@raag/domain', domain],
    ['@raag/core', core],
    ['@raag/application', application],
    ['@raag/adapters', adapters],
    ['@raag/claude-code', claudeCode],
    ['@raag/codex', codex],
    ['@raag/kilo-code', kiloCode],
    ['@raag/generic', generic],
    ['@raag/telegram', telegram],
    ['@raag/policy', policy],
    ['@raag/security', security],
    ['@raag/database', database],
    ['@raag/protocol', protocol],
    ['@raag/config', config],
    ['@raag/logging', logging],
    ['@raag/testing', testing],
  ];

  it('every package exports its manifest name', () => {
    for (const [expected, actual] of identities) {
      expect(actual, expected).toBe(expected);
    }
  });

  it('app stubs carry identity through the facade packages they import', () => {
    expect(gatewayIdentity()).toContain('@raag/local-gateway');
    expect(gatewayIdentity()).toContain('@raag/core');
    expect(cliIdentity()).toContain('@raag/cli');
  });

  it('root manifest is the workspace host, not a deliverable', () => {
    const root = readJson<{ name: string; private: boolean }>(join(ROOT, 'package.json'));
    expect(root.name).toBe('@raag/root');
    expect(root.private).toBe(true);
  });

  it('no stray workspace directories are missing manifests', () => {
    expect(workspaceManifests(join(ROOT, 'packages'))).toHaveLength(16);
    expect(workspaceManifests(join(ROOT, 'apps'))).toHaveLength(4);
  });
});
