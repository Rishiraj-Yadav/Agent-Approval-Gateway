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

## Phase 2 — Core foundation implementation — **DONE** (this session)

Implemented (all framework-independent, all under `packages/`):

- **`@raag/domain`** — branded opaque IDs (ADR-021), `DomainError`
  (field+code only, never values), time model (`Millis`/branded
  `DurationMillis`, spec default TTL 120 s / hard cap 1 h — ADR-023), risk,
  decision kinds with explicit scopes (allow-once / allow-session / deny /
  stop-agent — ADR-022), eight-state lifecycle **pure reducer**
  (ADR-019: duplicates → `duplicate`, wrong decisions → `conflict`,
  late events → typed outcomes; terminal states immovable; inclusive
  expiry boundary), audit event factory with scalar-only detail contract,
  domain-owned ports (`Clock`, `IdGenerator`, `ApprovalRepository`,
  `AuditSink` — ADR-020), validation at every constructor, revival
  (`revive`) that rejects impossible state/decision combinations. ESLint +
  meta-test enforce relative-only imports in `src`.
- **`@raag/application`** — `ApprovalManager` (only state-advancing
  component): durable-first ingress, policy short-circuit BEFORE prompts,
  core-clock re-stamping of creation times, idempotent decisions,
  expiry sweeps, cancel/disconnect, **audit-before-store** coupling;
  interaction ports (`PolicyEngine`, `NotificationProvider`,
  `ApprovalChannel`, `AgentAdapter`, `Transport`) each with WHY-docs.
- **`@raag/security`** — deterministic+idempotent redaction: string rules
  (PEM/JWT/bot-token/AWS/bearer/authorization/kv/long-base64) and structural
  deep-walk (`null`-prototype outputs, sensitive names → whole value,
  depth/breadth/cycle bounds). **Limitations stated, not hidden** (ADR-025).
- **`@raag/config`** — fail-closed env parser + loader: loopback-only bind
  (wildcards/routable fatal), HMAC ≥32 chars + anti-placeholder + Shannon
  ≥3.5 bits/char (chosen minimums documented — ADR-024), TTL bounds
  1..3600, relay all-or-nothing https-only; **errors never echo values**
  (asserted).
- **`@raag/logging`** — structured JSON-line logger, level filtering,
  every string (message + metadata) through security redaction; scalar-only
  metadata; console/test sinks injected (no backend).
- **`@raag/protocol`** — `raag.v1` submit/decision/reject DTOs; strict
  `parseMessage` (exact field sets, opaque-ID/shape rules, sha256-only,
  body caps, control-char hostile input rejected, opaque callback tokens
  cannot carry executable syntax); no transports.
- **`@raag/database`** — `InMemoryApprovalRepository` +
  `InMemoryAuditSink`; CAS enforces version+monotonic transitions and
  refuses scope/identity/timer reshaping; **explicitly NOT crash-persistent**
  (SQLite is the database phase — conformance suite in `@raag/testing` is
  the shared contract for it).
- **`@raag/testing`** — fake clock, fixed ids, collecting audit sink,
  valid-by-construction fixtures, repository conformance harness (ADR-010
  seam).
- **`@raag/claude-code`** — **SKELETON ONLY**: pure normalization of a
  documented PreToolUse-shaped payload (SHA-256 digest + redacted display,
  raw payload never stored; hostile/unknown shapes fail closed) and inert
  decision rendering; zero I/O, zero integration claims (ADR-027).
- Toolchain: **type-aware ESLint** (ADR-028), **coverage** via
  `@vitest/coverage-v8` + floors enforced in `test:coverage` + CI
  (ADR-029); architecture restrictions strengthened, never weakened.

Docs reconciled: architecture.md §14/§15 rewritten to the implemented
8-state machine (ADR-019; the older draft names are mapped inline),
security.md §4 now lists the exact implemented thresholds, testing.md +
this file updated. ADRs 019–029 added.

## Current phase status

| Item                                                           | Status                                                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| domain (machine, request, validation, IDs, decisions, audit)   | implemented + tested (42 unit tests)                                                                            |
| security/config/logging/protocol/database/testing packages     | implemented + tested                                                                                            |
| application ApprovalManager + ports                            | implemented + tested                                                                                            |
| claude-code adapter                                            | **SKELETON ONLY** (normalization tested; no integration)                                                        |
| Telegram / real agents / HTTP / relay / SQLite / policy engine | **NOT IMPLEMENTED** (planned)                                                                                   |
| type-aware lint + coverage floors                              | implemented + enforced in CI chain                                                                              |
| CI                                                             | workflow updated (coverage step); repo committed locally, no GitHub remote yet — remote execution still pending |

## Verification (this phase, all re-run before commit)

| Command                                | Result                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `npm ci`                               | 0 exit, workspaces link                                                 |
| `npm run typecheck`                    | 0 errors (composite graph + dev-project incl. tests)                    |
| `npm run lint`                         | 0 (type-aware, incl. import restrictions)                               |
| `npm run format:check`                 | All matched files use Prettier code style!                              |
| `npm test` (unit+integration+security) | **16 files, 153 passed**                                                |
| `npm run test:coverage`                | **92.5% stmts / 88.4% branch / 99.2% funcs / 94.5% lines — floors met** |
| `npm run build`                        | `tsc -b` exit 0                                                         |
| `npm run check`                        | full chain green                                                        |

## Technical debt / known limitations (Phase 2)

1. **Concurrency is cooperative single-writer only.** CAS is real at the
   port level, but transactional/serialized guarantees belong to the DB
   phase (ADR-010 conformance is the enforcement seam) — documented, not
   fake-claimed.
2. Delivery tracking: decisions are terminal domain states; "delivered"
   facts are audit events only until transports/adapters exist (§14).
3. E2E/perf tier directories exist but have no cases yet (by design;
   testing.md schedule).
4. Telegram SDK decision (ADR-011) deliberately **still open** — nothing
   imports a vendor yet.
5. Adapters codex/kilo/generic remain placeholder exports.
6. `renderHookDecision` returns inert strings — the eventual stdout write
   is a Phase-3 hook-runtime concern (ADR-027 wording is normative).

## Next phase — Phase 3 (scope)

1. `tests/fixtures/`: recorded Claude Code hook payloads to pin the real
   native schema (removes the ADR-027 hand-written-sample caveat).
2. Loopback transport: `node:http` on 127.0.0.1-only (+bind re-validation
   via `@raag/config`), bearer token file, size/schema limits through
   `@raag/protocol`, decision long-poll endpoint, composition-root wiring
   in `apps/local-gateway`.
3. Real Claude Code hook bridge (stdin JSON → normalize → block → native
   decision): adapter package owns the hook script; no command execution
   (ADR-004 remains absolute).
4. Policy engine `@raag/policy` local deny-first rules + auto-allow format
   - expiry scheduler loop (drives `expireDue`).
5. SQLite `@raag/database` backend — runtime-dep approval ADR first, then
   `@raag/testing`'s repository conformance suite IS the acceptance gate.

## Blocked / pending

- GitHub CI **execution**: git repo exists with Phase 0/1/2 committed;
  needs a GitHub remote created + pushed (account action, outside a coding
  phase's mandate).
