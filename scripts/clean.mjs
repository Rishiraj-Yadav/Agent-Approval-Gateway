import { rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const targets = ['dist', 'coverage', 'tsconfig.tsbuildinfo'];
const dirs = ['packages', 'apps'];
for (const top of dirs) {
  for (const entry of (await import('node:fs')).readdirSync(top, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = join(top, entry.name);
    if (pkgDir === join('packages', 'adapters')) continue;
    const srcs = [
      pkgDir,
      join(pkgDir, 'claude-code'),
      join(pkgDir, 'codex'),
      join(pkgDir, 'kilo-code'),
      join(pkgDir, 'generic'),
    ];
    for (const s of srcs) {
      for (const t of targets) rmSync(join(s, t), { recursive: true, force: true });
      if (existsSync(join(s, 'tsconfig.tsbuildinfo')))
        rmSync(join(s, 'tsconfig.tsbuildinfo'), { force: true });
    }
  }
}
