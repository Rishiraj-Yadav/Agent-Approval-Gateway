import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Alias @raag/* package names straight to their TypeScript sources so unit
 * tests never depend on build order (ADR: tests run before build in CI).
 */
function packageAliases(): Record<string, string> {
  const dirs = ['packages', join('packages', 'adapters'), 'apps'];
  const alias: Record<string, string> = {};
  for (const dir of dirs) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgDir = join(dir, entry.name);
      const pkgJsonPath = join(pkgDir, 'package.json');
      const srcIndex = join(pkgDir, 'src', 'index.ts');
      if (!existsSync(pkgJsonPath) || !existsSync(srcIndex)) continue;
      const name = (JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name: string }).name;
      alias[name] = srcIndex;
    }
  }
  return alias;
}

const testDirs = ['unit', 'integration', 'security', 'e2e'] as const;

// Per-package colocated tests join the unit tier.
const unitInclude = [
  'tests/unit/**/*.test.ts',
  'packages/*/tests/**/*.test.ts',
  'packages/adapters/*/tests/**/*.test.ts',
];

export default defineConfig({
  resolve: { alias: packageAliases() },
  test: {
    projects: testDirs.map((tier) => ({
      extends: true,
      test: { name: tier, include: tier === 'unit' ? unitInclude : [`tests/${tier}/**/*.test.ts`] },
    })),
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'packages/adapters/*/src/**'],
      // index.ts barrels are pure re-exports; @raag/testing is test-only
      // infrastructure, not production code (ADR-024).
      exclude: ['**/index.ts', '**/*.d.ts', 'packages/testing/src/**'],
      reporter: ['text', 'json-summary'],
      // Phase 2 floors (ADR-024): security-critical pure logic held highest.
      thresholds: {
        lines: 90,
        statements: 90,
        branches: 85,
        functions: 90,
      },
    },
  },
});
