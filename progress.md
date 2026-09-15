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

## Phase 3 — Durable persistence & local gateway foundation — **DONE** (this session)

Implemented:

- **Driver:** Node's built-in `node:sqlite` (`DatabaseSync`) — re-evaluated
  per §4; zero new runtime or dev dependencies, no native build on the
  Windows+Linux CI matrix, sync API fits the single-writer model
  (ADR-031; ADR-009's better-sqlite3 preference amended).
- **Migrations** (ADR-032): versioned via `PRAGMA user_version` (authoritative,
  checked per open), `BEGIN IMMEDIATE` transactions, `BEGIN` failure rolled
  back without touching committed state, FUTURE schema refuses startup
  (never destructive-downgrade/data loss), no implicit recreation.
- **Pragmas** (ADR-032): WAL + `synchronous=FULL` (fsync per commit),
  busy_timeout 5s, foreign_keys ON, `PRAGMA quick_check` integrity probe on
  every open — corrupt/garbage file never serves approvals.
- **Durable repository + audit** (`@raag/database/sqlite`): the shared
  conformance contract (ADR-010) runs against `InMemoryApprovalRepository`
  AND `SqliteApprovalRepository` — identical behavior. CAS is ONE pinned
  immutable + expected-revision UPDATE (test: approve vs deny race admits
  exactly one winner; scope/timer/identity reshaping, terminal rewrites,
  missing/ghost ids, and closed-handle reads all fail closed).
- **Atomic decision+audit** (`TransactionScope` port + `ApprovalManager.
commitTransition`, ADR-030): CAS + audit INSERT commit inside one
  `BEGIN IMMEDIATE` serialized through a promise-mutex; an audit disk
  failure ROLLS BACK the approval write (state stays `pending` →
  `expireDue` deny-closes; never approved-unaudited, never
  audited-but-advanced). Cooperative mirror `inMemoryTransactionScope`
  keeps semantics uniform.
- **Restart reconciliation** (ADR-033): on boot the gateway expires lapsed
  pendings (audited per request) and abandons orphan `created` rows to
  `failed(persistence-error)`; terminal rows byte-unchanged; **no code path
  can approve during recovery**.
- **Local gateway (`apps/local-gateway`):** GatewayCore = byte cap →
  strict envelope parse → constant-time verifyMac → replay/skew guard →
  scope re-check against stored data → ApprovalManager; WaiterRegistry
  keyed by requestId, wakes ONLY via terminal snapshot, bounded 1024 +
  window timers + idempotent settle/drop/clearAll; shutdown releases
  waiters WITHOUT fabricating decisions; IPC = named pipes (win) /
  chmod-600 UDS (posix), exclusive bind, ≤16 conns, NDJSON ≤256KB,
  maxConnections override test-only; HMAC envelope auth (ts+nonce bound,
  FIFO nonce replay cache, ±60s skew — ADR-034); GatewayClient for hook
  shims/tests; `defaultIpcPath` per-user; fail-closed bootstrap ordering in
  `main.ts` (config → key → store/migrate/integrity → core → reconcile →
  listen → sweeper; any failure exits non-zero before serving; SIGINT/SIGTERM
  graceful stop).

## Current phase status

| Item                                                         | Status                                                                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| domain (machine, request, validation, IDs, decisions, audit) | implemented + tested                                                                                            |
| security/config/logging/protocol/packages                    | implemented + tested (Phase 3 adds auth + envelope protocol)                                                    |
| application ApprovalManager                                  | implemented + **transactional CAS+audit commit** (ADR-030)                                                      |
| durable database (`@raag/database`)                          | **implemented**: SQLite store (node:sqlite), migrations, pragmas, conformance on BOTH stores, restart reconcile |
| local gateway `apps/local-gateway`                           | **implemented (foundation)**: pipe/UDS + HMAC auth + replay + waiters + shutdown; no Telegram wired             |
| claude-code adapter                                          | **SKELETON ONLY** (normalization tested; hook runtime & fixtures are Phase 4)                                   |
| policy engine, relay, Telegram, real agent adapters          | **NOT IMPLEMENTED** (planned — ports only)                                                                      |
| GitHub CI                                                    | workflow current; repo has Phase 0/1/2 commits, Phase 3 uncommitted at report time — remote still pending       |

## Verification (this phase, all re-run before commit)

| Command                                | Result                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `npm ci`                               | 0 exit, workspaces link                                                 |
| `npm run typecheck`                    | 0 errors (composite graph + dev-project incl. tests)                    |
| `npm run lint`                         | 0 (type-aware, incl. import restrictions)                               |
| `npm run format:check`                 | All matched files use Prettier code style!                              |
| `npm test` (unit+integration+security) | **27 files, 247 passed**                                                |
| `npm run test:coverage`                | **90.6% stmts / 85.7% branch / 95.5% funcs / 93.0% lines — floors met** |
| `npm run build`                        | `tsc -b` exit 0                                                         |
| `npm run check`                        | full chain green                                                        |
| Flake-hunt sample                      | 10 consecutive clean unit-pool runs after the base64url-nonce fix       |

## Technical debt / known limitations (updated Phase 3)

1. Delivery tracking: decisions are terminal domain states; "delivered"
   facts are audit events until adapters/transport runtimes exist (§14).
2. `node:sqlite` is experimental on Node 22 (ADR-031 accepted risk; the
   conformance suite + pragmas/integrity tests make any future driver swap a
   leaf change). No external driver was added; revisit on Node 24 floor.
3. E2E/perf tier directories exist but hold no cases yet (by design;
   testing.md schedule); soak tests (§22/§19 1k-waiter) are a Phase-4/5
   concern.
4. Telegram SDK decision (ADR-011) still open — still zero vendor imports.
5. Claude-Code hook _runtime_ (stdin→stdout bridge) and Codex/Kilo/generic
   adapters: still skeleton/placeholder (Phase 4+).
6. The response frames from gateway → client are deliberately NOT MAC'd
   (outbound); threat model documented in ADR-034 — revisit if a hostile
   local-user scenario ever matters.

## Next phase — Phase 4 (suggested scope)

1. `@raag/policy`: deny-first local rules engine + local-deny irrevocability;
   feed `ApprovalManager.policy` (port already exists).
2. Real Claude Code hook bridge script (stdin JSON → GatewayClient → answer
   the native prompt) + `tests/fixtures/` recorded payload pinning; adapter
   package owns it; no command execution (ADR-004 absolute); Codex/Kilo
   adapters become real adapters against the same port.
3. Telegram channel (ADR-011 SDK pick + chat-ID/HMAC callback intake) —
   the reason channel/NotificationProvider ports exist unchanged.
4. Optional relay transport implementing the existing `Transport` port
   (per-gateway keys, signed frames), split-deployment composition in
   `apps/relay`.

## Blocked / pending

- GitHub CI **execution**: git repo exists with Phase 0/1/2 committed;
  Phase 3 tree is staged-but-uncommitted at report time; a GitHub remote
  must still be created+pushed (account action, outside a coding phase's
  mandate).
- **Claude hook payload samples are hand-written** from documented shapes;
  no live-CLI validation (ADR-027 honesty; Phase-4 recorded fixtures).
