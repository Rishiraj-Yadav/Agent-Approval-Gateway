# Architecture Decision Records

Format: NDC-style (Context → Decision → Consequences). Statuses:
`accepted` | `superseded` | `proposed`.

---

## ADR-001 — Scope and UX constraint

**Status:** accepted
**Context:** Project must approve/deny AI-agent permission prompts remotely.
**Decision:** v1 ships Telegram as the _only_ remote UI. No web dashboard, no
mobile app, no Electron. Telegram is a notification/decision _channel_, never
an execution path.
**Consequences:** All domain types stay channel-agnostic; a future UI is added
as another channel (§ 21 of architecture) without core changes.

## ADR-002 — Modular monolith, not microservices

**Status:** accepted
**Context:** Approval state must be transactional and durable; process
boundaries multiply failure modes (partial approvals, split-brain decisions).
**Decision:** One process hosts core + policy + audit + channel + adapters.
Isolation is by **package boundary + dependency rule**, not network boundary.
**Consequences:** Fast, deadlock-free state transitions; extension point for
multi-machine is the optional `Transport`/relay layer, not a rewrite.

## ADR-003 — Dependency inversion via `packages/*/src/ports`

**Status:** accepted
**Context:** Core must not import Telegram SDK, SQLite driver, or agent SDKs.
**Decision:** Define interfaces (`AgentAdapter`, `ApprovalChannel`,
`NotificationProvider`, `PolicyEngine`, `Transport`, `Repository`,
`AuditLogger`, `Clock`) in domain-adjacent packages; concrete implementations
live in leaf packages; only the composition root wires them.
**Consequences:** Testability (in-memory fakes), swappable vendors, and a
lint-enforceable import rule.

## ADR-004 — No execution primitive anywhere

**Status:** accepted — this is a feature, not a limitation.
**Context:** A gateway that can run commands is an RCE target if Telegram or
agent input is compromised.
**Decision:** The codebase contains no path mapping "message received" →
"process.spawn". Decisions are `{allow, deny}` enum values only. Enforced by
review and a Phase 3 dependency lint ban on child-process APIs in
`core/policy/channels`.
**Consequences:** Simpler threat model; feature requests like "remote command
execution" are explicitly out of product, not just out of scope.

## ADR-005 — Per-agent adapters normalize to one `ApprovalRequest`

**Status:** accepted
**Context:** Claude Code (hook JSON on stdio), Codex (approval flags/notify),
and Kilo Code (extension bridge) expose different surfaces.
**Decision:** Adapters are the only components that know an agent's native
format; each normalizes into the common `ApprovalRequest` and translates
decisions back. Adapters carry no policy logic.
**Consequences:** New agents = new adapter package; core is stable. Native
prompt semantics preserved (allow looks identical to native local allow).

## ADR-006 — Telegram callbacks carry HMAC tokens; identity is allowlisted chat ID

**Status:** accepted
**Context:** Users can be @mentioned, forwarded messages can spoof context,
and callback data is attacker-controlled text.
**Decision:** A decision is valid only if (a) `from.id` is in the configured
operator allowlist AND (b) the callback's embedded `HMAC(secret,
requestId‖decision)` verifies. Free-text is never parsed as a decision.
**Consequences:** Impersonation by chat handle is useless; forwarded-button
replay fails (wrong ID / wrong request / already-resolved state machine reject).

## ADR-007 — Fail-closed defaulting

**Status:** accepted
**Context:** Every ambiguous outcome (crash, timeout, unknown state, DB error)
must map to a safe value.
**Decision:** The absence of an explicit, fresh, authorized `allow` is always
a `deny`. Policy errors escalate to NEED_HUMAN at most, never ALLOW.
**Consequences:** Infrastructure degradation never silently widens agent
permissions; operators may feel "the bot is slow to approve" — accepted trade.

## ADR-008 — Local gateway on loopback/IPC with user-scoped bearer token

**Status:** accepted
**Context:** Agent hook scripts must reach the gateway without exposing it to
the network.
**Decision:** `node:http` server bound to `127.0.0.1` only (or UDS/pipe where
available). Startup generates a random bearer token written to a `0600` file;
hook shims (same OS user, spawned by the agent) present it on every request.
**Consequences:** No TLS complexity locally; other users on the machine cannot
forge requests; startup hard-fails if configured bind is non-loopback.

## ADR-009 — SQLite via `better-sqlite3`

**Status:** accepted
**Context:** Need durable, transactional, restart-safe state with zero ops.
**Decision:** Embedded SQLite (WAL, `synchronous=FULL` on decision writes),
accessed only through the `Repository` port. Synchronous driver matches the
single-writer concurrency model.
**Consequences:** Fine at v1 scale (single operator); port to Postgres would be
a new `Repository` impl. License: MIT. Maintained (active releases).

## ADR-010 — In-memory `Repository` for tests/dev; SQLite for real state

**Status:** accepted
**Context:** Unit tests must not touch disk; dev mode should run with one file.
**Decision:** Two impls of the same port. Default config uses SQLite; test
harness uses the in-memory one.
**Consequences:** Divergence risk → mitigated by a shared **conformance test
suite** run against both impls.

## ADR-011 — Telegram transport: grammY over raw fetch (verify at build time)

**Status:** proposed → decide during Phase 1 Telegram work
**Context:** Need long polling, callback handling, and message edits.
**Decision:** Lean toward grammY (MIT, actively maintained, TS-first, zero
heavy runtime deps). Raw Bot API via `fetch` remains an option if supply-chain
review objects. Either way the Telegram SDK may be imported only from
`packages/telegram`.
**Consequences:** A thin wrapper makes a later swap painless regardless.

## ADR-012 — Ports publishable as their own package without restructure

**Status:** accepted (design constraint)
**Context:** Third-party adapters/channels are a stated extension goal.
**Decision:** Keep port interfaces free of implementation imports and in a
package that could be published as `@raag/ports` with a version bump —
no structural change needed later.
**Consequences:** Slight discipline cost now; large third-party ecosystem
option later.

---

## ADR-013 — Monorepo: npm workspaces + project references

**Status:** accepted (Phase 1)
**Context:** Need a strict TypeScript monorepo with apps/ and packages/. npm
10.9.8 is already installed with Node 22 (verified in repo). Pnpm adds a
version-manager dependency with no need-served here.
**Decision:** **npm workspaces** for dependency/hoisting management plus
**TypeScript project references** (`tsc -b`) as the build system: every
package's `tsconfig.json` is `composite: true` and references the packages it
imports; a root `tsconfig.json` aggregates all references. Build order,
incremental rebuilds, and declaration emit come for free with zero extra
dependencies. `packages/testing` is a **public** TS package (exports test
fixtures/helpers) so tests import it by name.
**Consequences:** One lockfile, one dependency tree, offline-friendly builds.
Cost: every package needs a `tsconfig.json` with correct `references` —
mitigated by the foundation meta-test that validates the graph.

## ADR-014 — Lint/format: ESLint 10 flat config + typescript-eslint, Prettier

**Status:** accepted (Phase 1)
**Context:** "Linting and formatting" required. TypeScript's first-party lint
ecosystem is `typescript-eslint`; npm surfaced a deprecation warning for the
entire ESLint 9 line at install time, so the current major is 10. The
dependency **rule** from architecture.md (core must not import SDKs/drivers)
is enforced at Phase 1 with ESLint's built-in **`no-restricted-imports`**
(targeted patterns) instead of the heavier `eslint-plugin-boundaries`.
Prettier handles formatting exclusively; both run as separate CI steps
(`lint`, `format:check`) so failures are attributed cheaply.
**Decision:** eslint ^10 + @eslint/js ^10 + typescript-eslint ^8.70 (declares
eslint 8.57–10 peer support) + prettier ^3.9. Type-aware rules deferred to
Phase 2 (`recommendedTypeChecked`) once domain code exists. Biome rejected:
not TS-aware at rule parity yet. License MIT, all actively maintained.
**Consequences:** Two tools but each does one job well; the import-rule
patterns are centralized in `eslint.config.js` and reviewed like code.

## ADR-015 — Testing: Vitest with explicit `tests/` layout

**Status:** accepted (Phase 1)
**Context:** "Test framework + test configuration" required; future security
and e2e suites must be selectable by CI job or tag.
**Decision:** **Vitest 3** (`type: module` ESM-native, fast, TS out of the box
— replaces the placeholder `npm test`). Test dir layout mirrors the spec:
`tests/{unit,integration,security,e2e,fixtures}`, each with a `vitest`
environment/config picked via root config's `test.projects`. The current
placeholder unit tests live in `tests/unit/`.
**Consequences:** Standard library `node:test` rejected (no watch/v8 coverage
integration out of the box, more boilerplate for TS); Mocha+chai rejected
(adds dependency surface for no benefit). Vitest is currently one of the most
downloaded test runners in npm — maintenance verified at install time.

## ADR-016 — CI: GitHub Actions, matrix ubuntu-latest + windows-latest

**Status:** accepted (Phase 1)
**Context:** Repo has no git remote yet, but CI must be ready to run the
required five steps in order: install → typecheck → lint → tests → build (lint
before tests/build so style failures are cheap early feedback). Target dev
machine is Windows; target deployment is Linux/Node — parity matrix catches
path-sep and EOL bugs now, not in Phase 3.
**Decision:** `.github/workflows/ci.yml` with a `runs-on` matrix over
`[ubuntu-latest, windows-latest]`, Node 22, `npm ci`, then typecheck → lint →
test → build (+ `format:check`).
**Consequences:** CI-only dependency (none installed); workflow will remain
unverified until the repo gets a GitHub remote — noted in progress.md.

## ADR-017 — Runtime dependency policy

**Status:** accepted (Phase 1)
**Context:** Instruction: prefer stdlib, justify every dependency.
**Decision:** Phase 1 adds **no runtime dependencies** — only the dev
toolchain: `typescript`, `@types/node`, `eslint`, `typescript-eslint`,
`prettier`, `vitest`. HTTP server is `node:http` (not express/fastify);
config is `node:fs`+JSON/YAML parsed ourselves only if needed; no http
framework, no ORM, no dotenv (env loading via plain `process.env` + a thin
parser in `packages/config`). Rationale for each:

- `typescript`/`@types/node`: the language toolchain itself.
- `eslint`/`typescript-eslint`/`prettier`: required lint + format tooling.
- `vitest`: required test framework.

First-party runtime package installs (grammY, better-sqlite3) happen in later
phases with their own ADRs confirming maintenance status and licenses (both MIT
at analysis time).
**Consequences:** Tiny supply chain today; every future install gets a
justification record here.

## ADR-018 — domain/application/core split inside packages/

**Status:** accepted (Phase 1)
**Context:** The spec's directory list places agent adapters _under_
`packages/adapters/` and lists generic adapter too. We follow it exactly. The
one structural deviation from a naïve reading: **`packages/core` vs
`packages/application` vs `packages/domain`** — the spec requires all three, so
we split: `domain` = types + ports + state machine (zero deps), `application`
= use-case orchestration (Approval Manager, expiry scheduler), `core` = the
composition/facade barrel used by apps. This matches the architecture's layer
table while preserving the requested folder names.
**Consequences:** Three thin packages instead of one `core`; the meta-test
asserts `domain` imports nothing outside itself to keep the dependency rule real.

## ADR-019 — State machine: eight named states, pure reducer, audit-before-store

**Status:** accepted (Phase 2)
**Context:** Phase 0 drafted lifecycle names (`submitted/.../abandoned/
delivered/closed`), while the Phase 2 specification mandates the set
CREATED, PENDING, APPROVED, DENIED, EXPIRED, CANCELLED, AGENT_DISCONNECTED,
FAILED — and approval _must_ be modeled as a state machine, never a boolean.
**Decision:** The implemented domain (`packages/domain`) uses exactly the
eight spec states. `submitted`→`created`, `abandoned`→`agent-disconnected`;
`delivered/undelivered/closed` are deliberately NOT states (a terminal
decision is immutable by invariant); delivery is expressed as application
audit events in later phases. The reducer returns typed outcomes
(`advanced | duplicate | no-change | conflict | rejected`) instead of
throwing on legal-but-useless events, and bumps an optimistic-concurrency
`version` on every advance. Expiry is **inclusive** (`now >= expiresAt` is
expired), and the core clock re-stamps every creation instant — callers
cannot extend TTLs by lying about their own clocks. **Audit-before-store:**
a decision transition never writes the store if its durable audit append
failed (prevention, not rollback — terminal states cannot be un-decided, so
there is nothing unsafe to revert). docs/architecture.md §14/§15 rewritten to
match. `expired`, `cancelled`, `agent-disconnected`, `failed` are
deny-equivalents (§16).

## ADR-020 — Port placement: domain owns storage/temporal ports, application owns interaction ports

**Status:** accepted (Phase 2)
**Context:** Both layers legitimately host abstractions; a blanket "all
ports in one package" rule makes either layer import-heavy and blurs the
dependency rule.
**Decision:** `@raag/domain` defines ports whose vocabulary is pure data
(`Clock`, `IdGenerator`, `ApprovalRepository`, `AuditSink`) — because those
contracts ARE domain language. The application layer defines interaction
ports (`PolicyEngine`, `NotificationProvider`, `ApprovalChannel`,
`AgentAdapter`, `Transport`) that coordinate I/O boundaries. `ApprovalService`
was intentionally NOT created as a port: `ApprovalManager` already is that
service; a same-shaped interface would be a speculative abstraction.
Every port file carries a "WHY" comment; ports without a planned consumer
are rejected.
**Consequences:** The architecture lint restricts domain to relative-only
imports; application to domain types + its own ports; vendor code only in
leaf implementations of these ports (future phases).

## ADR-021 — Branded opaque IDs; one ID alphabet

**Status:** accepted (Phase 2)
**Context:** `requestId`, `correlationId`, `machineId`, `sessionId`,
`projectId` flowing as bare `string` invites silent cross-wiring bugs and
hostile-shape injection.
**Decision:** Each ID family is its own TypeScript brand (`OpaqueId<T>`,
zero-cost, no runtime tag). One shared alphabet
`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` — whitespace, punctuation, path and
shell metacharacters are structurally impossible in any ID, so IDs are safe
inside log JSON, wire frames and eventually Telegram callback data.
Parsing functions live in domain, are total (`unknown` in), and throw
`DomainError("invalid-id", field)` quoting only the _rule_, never the value.
**Consequences:** Cross-brand mixups become compile errors; adapter code
must validate IDs through the same functions (fail closed before domain
construction).

## ADR-022 — Decision kinds carry scope; four kinds, two allow classes

**Status:** accepted (Phase 2)
**Context:** Operators can answer with "Allow Once", "Allow Session", "Deny",
"Stop Agent"; booleans lose the distinction, and "session" must not become a
persistent privilege the core forgets tracking.
**Decision:** `DecisionKind = allow-once | allow-session | deny | stop-agent`
in domain. `terminalStateForDecision` is the only place mapping kinds to
terminal states (allow-variant → approved, deny/stop → denied);
`decisionHasSessionScope` / `decisionRequestsStop` expose the semantic flags.
What _enforcement_ of session-scope or stop means (adapters, policy rules) is
deliberately out of domain scope for later phases — the domain records the
decision truthfully and nothing else. Duplicate identical decisions are
idempotent `duplicate` outcomes; conflicting decisions are `conflict` and
never overwrite a terminal state.
**Consequences:** No decision concept can accidentally collapse to `true`.

## ADR-023 — Time model: core clock, branded millis, TTL range

**Status:** accepted (Phase 2)
**Context:** Expiry semantics must be testable to the exact boundary, and
specification mandates 120 s default; a magic `120000` scattered through code
repeats the classic unit-confusion bug.
**Decision:** `DEFAULT_APPROVAL_TTL_SECONDS = 120` is one domain constant
used by config defaults and the request factory. Durations are a branded
`DurationMillis`; `secondsToDuration` enforces an integer-seconds domain and
the range 1..3600 (hard cap documented as fail-closed hygiene: no
"approve-me-tomorrow" requests). All "now" reads come from a `Clock` port —
domain code never calls `Date.now()`; the production clock lives in
`@raag/testing` only until the gateway wiring phase gives it a home in
`@raag/config`/composition. Tests use the fake clock for inclusive-boundary
exactly (`expiresAt - 1`, `expiresAt`, `+1`) without sleeping.

## ADR-024 — Configuration validation thresholds (values never echoed)

**Status:** accepted (Phase 2)
**Context:** security.md required loopback-only binding and "HMAC key
entropy >= 32 bytes" but fixed no algorithm; §1-10 require zero default
secrets and secret-free error paths.
**Decision:** Implemented minimums: `GATEWAY_HOST` must be exactly
127.0.0.1 / localhost / ::1 — `0.0.0.0`, `::`, and every routable literal
are fatal config errors, never warnings or silent coercions.
`APPROVAL_HMAC_KEY`: non-empty, **>= 32 characters**, reject trivially
uniform keys and the placeholder words (change-me/dev/test/example/...),
**>= 3.5 Shannon bits/character** — the last is a chosen (documented)
minimum; it catches copy-paste "aaaa…" mistakes without pretending to
measure secret strength. Relay keys share the >= 32-char floor and require
`https://` only. Every error is a `{field, reason}` pair containing only
field names + static text; tests assert secret substrings are absent from
serialized results. Config never defaults a secret: the only defaulted
fields are public safe choices (host, ttl, log level); an omitted required
value simply fails. (A `.env` loader is Node built-in `--env-file` in a
later bootstrap — no dotenv dependency.)

## ADR-025 — Redaction: pattern+name rules, bounded traversal, honest limits

**Status:** accepted (Phase 2)
**Context:** §1-10 "secrets never to Telegram/logs"; arbitrary agent input
must be renderable for humans; naive regex "secret scanners" tempt people
into thinking unredacted leftovers are safe.
**Decision:** `@raag/security` provides deterministic, idempotent
`redactString` (PEM/JWT/bot-token/AWS/bearer/authorization/kv/base64-length
rules, ordered specific→generic) and `redactUnknown` (structural redaction:
sensitive field _names_ replace whole values; string leaves pass through;
depth/array/object caps; cycles broken; null-prototype outputs so hostile
`__proto__` entries never pollute the result). **Documented limitation:**
this is a defense-in-depth layer; the primary guarantees are the structural
ones — payloads are hashed+discarded, secrets live in env/config code never
touches, and channel callbacks carry HMAC tokens rather than text. Tests
cover API keys, bearer, bot tokens, password pairs, nested/huge/malicious
graphs, and idempotence rather than trusting a perfect scanner.

## ADR-026 — Protocol: exact-field DTOs, opaque tokens, no shell content in identifiers

**Status:** accepted (Phase 2)
**Context:** wire frames arrive from sockets/pipes and must be treated as
hostile even "inside the machine" (defense in depth).
**Decision:** `@raag/protocol` ships versioned DTOs (`raag.v1`: submit /
decision / reject) + `parseMessage(unknown)` that enforces exact key sets
(unknown field = reject), opaque-ID patterns, sha256-only content fields,
bounded ints, a 256 KB body cap, printable-only display text, and opaque
base64url tokens (`^[A-Za-z0-9_-]{8,256}={0,2}$`) that can carry no
whitespace/shell/URL syntax at all. Parsing never executes, evaluates, or
interpolates any field; `correlationId` rides unchanged through submit →
decision so responses route to their origin. NO transport is implemented
here (no HTTP/WS/Telegram sockets) — parseMessage is the untrusted-input
boundary for later phases.

## ADR-027 — Claude Code adapter skeleton: normalization + inert rendering only

**Status:** accepted (Phase 2 skeleton)
**Context:** Phase 2 forbids real agent integration but requires the first
adapter boundary to prove out the port shape.
**Decision:** `@raag/claude-code` implements the documentation-named
`PreToolUse` hook payload contract as pure functions: normalize
`tool_input → createApprovalRequest` with a SHA-256 digest (Node `crypto`
for the hash is fine — read-only, no subprocesses), never persisting raw
input; `renderHookDecision` returns literal strings for a later hook
runtime. No settings writes, no process I/O, no keyboard/terminal access,
no Telegram/database imports — enforced by the global child_process ban, the
import restrictions, and tests asserting the pure mapping + fail-closed
invalid-shape behavior. Codex/Kilo/generic
remain placeholder packages with the same independence (`@raag/domain`
only) — their skeletons are NOT implemented (not "wired" in docs).

## ADR-028 — Type-aware ESLint (Phase 2 §21 upgrade)

**Status:** accepted (Phase 2)
**Context:** Phase 1 used non-type-aware rules for install-free green.
**Decision:** `typescript-eslint` `recommendedTypeChecked` for packages'
src/tests + apps/tests + root tests, with `project: ./tsconfig.dev.json` —
chosen over `projectService` because dev.json is the existing
noEmit-everything project; zero new packages needed and project-reference
composite projects stay out of the lint program graph. Restrictive rules
kept; `dot-notation` off (untrusted-index style `input['field']` is the
convention for hostile payloads; property existence checks are intentional).
No architecture-restriction rule was weakened to make lint pass — each of
the 14 initial findings was fixed in code/tests instead (assertion, import,
union-narrowing removals).

## ADR-029 — Coverage: @vitest/coverage-v8 dev-dependency + floors 90/85/90/90

**Status:** accepted (Phase 2)
**Context:** §22: coverage without pretending; the existing Vitest needs a
provider package.
**Decision:** devDependency `@vitest/coverage-v8` (same version line as
vitest = its own project, MIT, zero runtime footprint; provider "v8" over
"c8" choice = maintained first-party). Floor: lines/stmts/functions 90,
branches 85. Included: `packages/*/src` + adapter sources; excluded:
`**/index.ts` barrels (no logic, they hold only re-exports) and
`packages/testing` (its own code is test infrastructure). Placeholder
skeletons without behavior are not counted as production code; the
placeholders that grow logic must grow tests. `npm run test:coverage`
enforces; CI runs it as the Tests step. Gap-closing tests raised the bar
rather than the bar being lowered (measured 92.5/88.4/99.2/94.5).
