# Progress Log

## Phase 0 — Project analysis & architecture

- **(interrupted before completing; finished retroactively at Phase 1 start)**
  `docs/architecture.md` (all 21 mandated sections), `architecture.md` (root
  pointer), `security.md`, `decisions.md` (ADR-001…012), `testing.md`,
  `README.md`, `AGENTS.md`, placeholder `package.json`/`tsconfig.json`,
  `.gitignore` were created. Repository was empty beforehand (verified: no
  files, no git).

## Phase 1 — Repository bootstrap — **DONE** (this session)

Implemented:

- **npm-workspaces monorepo** (`packages/*`, `packages/adapters/*`, `apps/*`)
  with 20 workspace manifests; layout follows the mandated structure
  (deviations recorded below).
- **Strict TS toolchain:** `tsconfig.base.json` (strict +
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, ES2023/NodeNext), project-reference **solution root**
  (`tsconfig.json`), per-project `tsconfig.json` with correct `references`,
  `tsconfig.dev.json` (noEmit view of everything incl. tests) used by the
  `typecheck` script.
- **Build:** `tsc -b` (incremental by default; `--force` in typecheck).
- **Lint:** ESLint 10 flat config + typescript-eslint 8 (non-type-aware rules
  — upgrade tracked below), ADR-004 child-process import ban, dependency-rule
  restrictions for `domain`, `core`, `application`.
- **Format:** Prettier 3 (`format`, `format:check`).
- **Tests:** Vitest 5 projects per tier; 3 test files / **19 tests, all
  passing**: `tests/unit/bootstrap.test.ts` (graph, strictness, purity),
  `tests/security/fail-closed.test.ts` (secrets/gitignore/no-listener/
  lifecycle-script hygiene), `tests/integration/workspace-resolution.test.ts`.
- **CI:** `.github/workflows/ci.yml` — ubuntu + windows matrix, Node 22,
  `npm ci → typecheck → lint → format:check → test → build` (exact spec order).
- **Env & hygiene:** `.env.example`, `.gitignore` (extended), `.gitattributes`
  (LF normalization — cross-OS CI), `.editorconfig`, `scripts/clean.mjs`.
- Lockfile committed (`package-lock.json`).

Verified commands (all green): `npm run typecheck`, `npx eslint .`,
`npm run format:check`, `npm test`, `npm run build`.

Deviations / notes (all justified):

1. **Adapters split:** four concrete adapter packages live inside
   `packages/adapters/<agent>/` as requested, plus a barrel package
   `packages/adapters` so apps import one name.
2. **`workspace:*` protocol dropped for bare `*`:** npm 10 doesn't link
   `workspace:`-prefixed specs; `"*"` + exact local `0.0.0` versions resolves
   and links via workspaces (verified by successful `npm ci`).
3. **Major-version picks:** registry now has ESLint 10 / Vitest 5 / TS 7; the
   deprecated warning on eslint 9 forced ≥10. **TypeScript stays 5.6+:** v7 is
   the Go-native rewrite — too new for a repo whose core rules are strictness
   flags; revisit as its own ADR.
4. **Per-package scripts:** `build` (`tsc -b`) only; per-package
   `typecheck --noEmit` is illegal with `composite` and removed; root scripts
   are the single entry points, as npm-workspaces convention intends.
5. **CI runs on a repo with no git history/remote yet** (git not initialized —
   not requested). Workflow is spec-correct but its first real run awaits
   `git init` + GitHub remote. Tracked as ⚠ below.

## Current phase status

| Item                                                           | Status                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------- |
| Monorepo, TS strict, build, lint, format, tests, CI, env files | implemented + tested (locally)                          |
| CI execution on GitHub                                         | written, **not executed** — repo has no git history yet |
| Vitest watch (`test:watch`)                                    | implemented, manual only                                |

## Next — Phase 2 (suggested scope)

1. Initialize git, push, confirm CI matrix turns green.
2. `@raag/domain`: real types, ports, state-machine reducer + exhaustive
   transition table tests (unit tier).
3. `@raag/security` redaction + `@raag/config` env/config loader;
   `@raag/logging`.
4. In-memory `Repository` + conformance harness in `@raag/testing`
   (FakeClock etc.).
5. Only after domain exists: first adapter skeleton + loopback transport.
6. Decide ADR-011 (Telegram SDK) when `@raag/telegram` work starts.

## Planned upgrades

- Type-aware ESLint rules (`recommendedTypeChecked`, projectService) in Phase 2.
- Coverage floors enforcement once code exists (testing.md §rules).
- `@raag/ports` publish split if ADR-012 gets exercised.

## Blocked

- GitHub CI **execution** — needs a git repo/remote to exist first (not part
  of this phase's mandate).
