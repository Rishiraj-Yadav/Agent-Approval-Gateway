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

export default defineConfig({
  resolve: { alias: packageAliases() },
  test: {
    projects: testDirs.map((tier) => ({
      extends: true,
      test: { name: tier, include: [`tests/${tier}/**/*.test.ts`] },
    })),
  },
});
