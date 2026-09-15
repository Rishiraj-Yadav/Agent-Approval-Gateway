# Remote Agent Approval Gateway — Architecture

> **Status:** Phase 0 — design document. No production code exists yet.
> Related: [security.md](../security.md) · [decisions.md](../decisions.md) ·
> [testing.md](../testing.md)

---

## 1. Product Overview

AI coding agents (Claude Code, Codex, Kilo Code) periodically ask for human
permission before performing sensitive actions — running a shell command,
editing a file outside the workspace, accessing the network. Today that
question blocks until a human is physically at the machine.

The **Remote Agent Approval Gateway** lets one human answer those questions
from anywhere, using **Telegram as the only remote UI**. Each agent session
connects to a **local gateway** running on the same machine as the agent. The
gateway normalizes each native permission prompt into a common
`ApprovalRequest`, evaluates a **local policy engine**, and if human input is
required, pushes an inline-keyboard message to the operator's Telegram chat.
The human taps _Approve_ / _Deny_; the decision is validated, recorded, and
returned to the originating agent process over the local channel.

The gateway is a **decision relay, never an execution engine**. Telegram sends
opaque reference tokens ("approve request `A7F3…`"), never instructions. There
is no path by which Telegram text can cause a command to run.

```
Coding Agent ──► Agent Adapter ──► Local Gateway (Approval Core)
                                      │        │
                                   Policy   Audit
                                   Engine    Logger
                                      │
                                   Notification
                                   Provider (outbound)
                                      │
                                   Telegram ◄── human
                                      │
                 decision ──► Approval Core ──► agent process
```

## 2. Goals

- **G1 — Remote authority, local execution.** A human can approve/deny agent
  permission prompts from a phone; all execution stays in the agent process.
- **G2 — Multi-agent via adapters.** Claude Code, Codex, and Kilo Code
  supported in v1 through separate adapters; new agents added without touching
  the Approval Core (see §20).
- **G3 — Fail closed.** Any failure (transport down, storage error, unknown
  state, expired request) resolves to **deny**, never allow.
- **G4 — Native semantics preserved.** Deny means the same thing to the agent
  as if the human had typed "no" locally; the gateway never weakens what an
  agent's permission system considers safe.
- **G5 — Auditable.** Every request, decision, timeout, and denial is written
  to an append-only audit log before the decision is delivered.
- **G6 — Safe under hostile input.** Telegram callbacks, agent-supplied
  payloads, and relay bytes are all treated as untrusted data (§16).
- **G7 — Works across machines.** The gateway can serve agents on a different
  machine than the one holding the Telegram connection, via an authenticated
  relay (§10, §19).
- **G8 — Multiple machines / projects / sessions.** One core instance can
  track many concurrent approval requests, disambiguated by scope keys (§14).

## 3. Non-goals (v1)

- **No Web UI, dashboard, mobile app, or Electron shell.** Telegram is the
  complete remote interface. (§21 defines the boundary for a future UI.)
- **No command execution from Telegram.** Not "deferred until phase 2" —
  architecturally absent (§16).
- **No approval-brokered privilege escalation.** The gateway can only approve
  actions the agent's own permission system would accept from a local human.
- **No multi-user / team features.** v1 serves exactly one operator chat.
- **No message parsing of natural language** ("approve it" / "looks fine").
  Decisions arrive only via cryptographically-checked callback tokens.
- **No Windows service wrapper, installer, or auto-update** in v1.
- **Not an MCP server, not an agent orchestrator, not a general-purpose secret
  manager.**

## 4. System Architecture

**Shape: modular monolith.** One Node.js process ("gateway") hosts the core,
loaded adapters, policy engine, audit logger, and notification provider.
Microservices are explicitly rejected (ADR-002): the components share state
(transactionally, in one store) and a process boundary would multiply failure
modes without buying isolation. Isolation is achieved by **package boundaries
enforced by dependency rules**, not by network boundaries.

Layers (top may depend on bottom, never the reverse):

```
┌──────────────────────────────────────────────────────┐
│ Composition root (src/gateway/main.ts)               │  wires concrete impls
├──────────────────────────────────────────────────────┤
│ Adapters        │ Channels        │ Transports       │  src/adapters,
│ claude-code     │ telegram        │ loopback, relay  │  src/channels,
│ codex · kilo    │ (future: …)     │                  │  src/transport
├──────────────────────────────────────────────────────┤
│ Policy engine · Audit · Repository impls             │  infrastructure for
│                                                      │  port interfaces
├──────────────────────────────────────────────────────┤
│ Approval Core (domain)  +  Ports (interfaces)        │  src/core, src/ports
│  ApprovalRequest · Decision · state machine          │  framework-free,
│  AgentAdapter · ApprovalChannel · PolicyEngine ·     │  zero external deps
│  Transport · Repository · AuditLogger · Notifier     │
└──────────────────────────────────────────────────────┘
```

- **Ports** (`src/ports/`) define every interface the core speaks to the
  outside: `AgentAdapter`, `ApprovalChannel`, `NotificationProvider`,
  `PolicyEngine`, `Transport`, `Repository`, `AuditLogger`, plus helpers
  (`Clock`, `IdGenerator`). This is textbook dependency inversion (ADR-003).
- The **core owns all state transitions**. Adapters and channels never mutate
  a request directly; they submit events (`submit()`, `resolve()`, `expire()`)
  and the core's state machine accepts or rejects them.
- The **composition root** is the only file that imports concrete classes
  (`TelegramChannel`, `ClaudeCodeAdapter`, `SqliteRepository`, …).

## 5. Component Responsibilities

| Component                          | Port                   | Responsibility                                                                                                                                                          | Must NOT                                                                       |
| ---------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Agent Adapter** (×3)             | `AgentAdapter`         | Bridge one agent's native permission mechanism to/from `ApprovalRequest`; translate decisions back into the agent's expected format; enforce per-agent session identity | Contain policy logic; talk to Telegram; outlive trust in the agent             |
| **Approval Core**                  | (domain)               | Own request lifecycle and state machine; enforce expiry, idempotency, scope routing                                                                                     | Import SDKs, drivers, or adapters                                              |
| **Policy Engine**                  | `PolicyEngine`         | Decide `auto-allow` / `auto-deny` / `need-human` from local rules; deny-first precedence                                                                                | Consult Telegram; override explicit local deny rules; fail open on rule errors |
| **Approval Manager** (inside core) | —                      | Single entry point: `submit`, `resolve`, `cancel`, `heartbeat`                                                                                                          | —                                                                              |
| **Audit Logger**                   | `AuditLogger`          | Append-only, durable record of every event, including failures                                                                                                          | Log secrets or full payloads containing secrets (§ security.md)                |
| **Repository**                     | `Repository`           | Durable request state; supports restart recovery                                                                                                                        | Be bypassed by adapters/channels                                               |
| **Notification Provider**          | `NotificationProvider` | Format and deliver human-facing prompts; expose decision intake                                                                                                         | Execute anything; parse free text into actions                                 |
| **Telegram Channel**               | `ApprovalChannel`      | Polling/webhook intake of callbacks; send messages/keyboards; enforce chat-ID allowlist                                                                                 | Receive raw agent payloads (it gets redacted digests only)                     |
| **Local Gateway**                  | —                      | Process hosting adapters + core on the agent's machine; loopback listener for agent hook integrations                                                                   | Expose itself beyond loopback unless relay is configured                       |
| **Relay**                          | `Transport`            | Authenticated, encrypted hop between a remote gateway and the core host (§10)                                                                                           | Interpret or act on payloads beyond routing metadata                           |

## 6. Data Flow

**Happy path (human decision required):**

```
1 agent process          → adapter           hook/IPC request {tool, args, session}
2 adapter                → core              ApprovalRequest {machine, project,
                                                 session, agent, action digest, ttl}
3 core                   → repository        insert status=pending  (durable first)
4 core                   → audit             event REQUESTED
5 core                   → policy engine     verdict = NEED_HUMAN
6 core                   → notifier          prompt (redacted summary + token)
7 notifier → telegram    → human             inline keyboard message
8 human taps APPROVE     → telegram          callback { data: "ap:<requestId>:<nonce>" }
9 telegram channel       → core              resolve(requestId, APPROVE, proof-of-
                                                 operator: chat_id + secret token)
10 core state machine    verify pending & not expired & first decision → status=approved
11 core                  → audit             event DECIDED (durable BEFORE delivery)
12 core                  → repository        update state
13 core                  → adapter           decision pushed over original transport
14 adapter               → agent             native allow response
15 telegram channel      → human             "✅ request <id> resolved — edited" (keyboard removed)
```

**Policy short-circuit:** at step 5 a `DENY` verdict skips steps 6–9 and
terminates at the agent with a deny; an `ALLOW` verdict is only possible for
rules explicitly configured as auto-allow (see deny-first precedence).

**Inbound trust boundaries:** step 1 crosses _untrusted agent → adapter_
(size-capped, schema-validated); step 8 crosses _untrusted Telegram → channel_
(signature/allowlist-checked). The core accepts data only from validated
adapters and the channel abstraction — it cannot tell the difference and
doesn't trust either (§16).

## 7. Agent Adapter Architecture

Adapters normalize **different permission surfaces** into one `ApprovalRequest`
(ADR-005). Each agent's mechanism is distinct and assumed unstable:

| Agent           | Native surface                                                                                             | Adapter approach                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code** | `PreToolUse` / permission hooks in settings; hooks communicate over stdin/stdout JSON with the CLI process | Hook script (`adapters/claude-code/hook`) posts to the loopback gateway; adapter maps hook payload → request; decision returned as hook's stdout `permissionDecision: allow/deny` |
| **Codex**       | `--ask-for-approval` / notify-style escalation; approval prompts surfaced by the CLI                       | Notify/IPC shim converts the native prompt into a loopback request; decision fed back through the same surface                                                                    |
| **Kilo Code**   | Native permission requests surfaced through its extension/API surface                                      | Extension-side shim bridges to the loopback gateway identically                                                                                                                   |

The `AgentAdapter` port:

```ts
interface AgentAdapter {
  readonly agentId: AgentKind; // "claude-code" | "codex" | "kilo"
  start(ctx: AdapterContext): Promise<void>; // ctx gives submit()/cancel() entry points
  stop(): Promise<void>;
  deliverDecision(req: ApprovalRequest, d: Decision): Promise<void>;
  health(): AdapterHealth;
}
```

Contract each adapter must honor:

1. **Normalization:** build `ApprovalRequest` with scope fields
   (`machineId`, `projectPath`, `sessionId`) and an **action digest** — a
   redacted, size-capped human-readable summary + raw hash (never raw secrets).
2. **Blocking semantics:** the adapter holds the agent's prompt open until the
   core returns a decision or the request expires; on adapter crash the agent's
   native prompt remains, so the human's remote "no path" degrades to _local
   behavior_, not auto-approval.
3. **Reversal guard:** if the decision can no longer be delivered (agent gone),
   the core marks `undelivered` and audits it; nothing is silently swallowed.
4. **No policy:** adapters ask the core; they never decide.
5. **Version pinning:** adapters record agent version per session; unknown
   payload shapes are rejected (fail closed) with an audit event.

Adding an agent = adding one folder under `src/adapters/<name>` implementing
`AgentAdapter` and one line in the composition root. No core changes (§20).

## 8. Telegram Architecture

Telegram is modeled as an `ApprovalChannel` + `NotificationProvider` pair:

```ts
interface NotificationProvider {
  notify(prompt: ApprovalPrompt): Promise<DeliveryReceipt>;
  editResolved(promptId: string, outcome: string): Promise<void>;
}
interface ApprovalChannel {
  onDecision(cb: (r: ResolvedDecision) => void): void; // validated decisions only
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

Key design points:

- **Library-agnostic core, thin vendor layer.** Telegram transport is wrapped
  in `channels/telegram/` using grammY (or Bot API over `fetch` — final pick in
  Phase 1, ADR-011). Only this folder may reference the SDK.
- **Connection mode: long polling by default.** The gateway is typically behind
  NAT with no public HTTPS endpoint; polling needs neither webhook TLS nor port
  forwarding. Webhook mode is an optional alternative transport behind the same
  interface.
- **Intake = callback queries only.** Decisions come exclusively from inline
  keyboard callbacks whose `data` is `ap:<requestId>:<decision>:<token>` where
  `token = HMAC(approval-secret, requestId‖decision)`. `callback_query.from.id`
  must be in the configured allowlist **and** the HMAC must verify; otherwise
  the callback is answered with "unauthorized" and audited (ADR-006). Free-text
  messages are never parsed as decisions (only fixed `/commands` like `/list`,
  `/pending`, which read state but cannot decide).
- **Outbound formatting:** each prompt message shows: request id (short), agent,
  machine, project, session age, action digest (truncated, redacted), TTL
  countdown, and two buttons. The **raw agent payload is never sent**; the
  digest is produced by the adapter's redaction step.
- **Idempotent buttons:** after a decision the keyboard is edited away
  (`editResolved`); a replayed callback finds the request non-pending and is
  rejected by the state machine, answering with "already resolved".
- **Rate & size hygiene:** message text is truncated to Telegram limits with an
  explicit "…" marker; excessive pending prompts are aggregated into one message
  with a per-item callback list.
- **Secrets:** bot token lives only in local config; the approval HMAC secret
  never leaves the machine. Neither is ever sent into any message.

## 9. Local Gateway

**Status (Phase 3): the durable foundation is IMPLEMENTED in
`apps/local-gateway`** (ADR-030/033/034). The current listener is **local IPC
with HMAC-authenticated envelope frames** (Windows named pipe / POSIX UDS),
NOT yet the HTTP loopback described below — the HTTP surface is deferred to
the adapter-runtime phase because nothing consumes it until hook scripts
exist; the security envelope is transport-independent and will also front any
later TCP fallback. Implemented behaviors: strict NDJSON framing, per-frame
HMAC over `ts|nonce|canonicalMessage` with constant-time verify + bounded
replay/skew guard, stored-data scope re-check, waiter registry keyed by
requestId, connection+body caps, and startup reconciliation (ADR-033). The
original design (kept for the HTTP phase):

The **local gateway** is the process running on the machine where agents run.
In the default single-machine deployment (§19a) it _is_ the whole modular
monolith. In the split deployment it is the agent-facing half: adapters +
loopback listener + a `Transport` client toward the core host.

- **Loopback listener** (`transport/loopback/`): HTTP/1.1 bound to
  `127.0.0.1` on a configurable port, served by `node:http` (no framework).
  Agent hook shims connect over a **Unix-domain socket on POSIX / named pipe on
  Windows** when available, falling back to loopback TCP with a **bearer token
  generated at gateway startup and written to a `0600` file** that only the
  hook (spawned by the same user) can read. Local peer-identity enforcement:
  same-user process check where the platform allows (ADR-008).
- **Surface:** `POST /v1/requests` (submit), `GET /v1/requests/:id` (status),
  long-poll `GET /v1/requests/:id/wait`, `POST /v1/cancel`. Bodies are size-
  capped (256 KB) and schema-validated; unknown fields rejected.
- **Liveness:** hook shims report parent PID + start time; gateway watches its
  registered sessions and cleans up when the agent process dies (requests
  transition to `abandoned`).
- The loopback port is **never** bound to non-localhost interfaces; startup
  fails hard if the configured bind is not loopback.

## 10. Relay

The **relay** (`transport/relay/`) extends trust across machines: a gateway on
machine _M_ (where agents run) forwards requests to the core/Telegram host
machine _H_ when the operator's desktop shouldn't host the Telegram bot or when
agents run on servers.

- Direction: gateway↔host **outbound-only from gateway to host** (gateway
  dials host; no listening port on machines running agents).
- Transport: WebSocket over TLS 1.3 (host runs the TLS terminator), or SSH
  tunnel as zero-config fallback (`ssh -R`). One persistent multiplexed
  connection per gateway.
- Authentication: per-gateway **long-lived bearer key** (random 256-bit,
  provisioned by the operator via config on both ends) + HMAC-signed frames.
  The host rejects unkeyed gateways and auditors unknown-key attempts.
- Payload over relay: already-normalized `ApprovalRequest` (redacted digest) +
  scope; decisions flow back on the same channel. The relay **routes by
  `machineId+sessionId`** and has no policy authority.
- Reliability: requests in flight during a relay outage expire by TTL and are
  denied (fail closed); the gateway buffers _submits_ for a short grace window
  but never buffers _decisions to re-apply later_ (a stale allow must never be
  replayed).
- The `Transport` port abstracts loopback vs relay identically to the core —
  the state machine does not know which is in use.

## 11. Database

**Status (Phase 3): IMPLEMENTED** in `@raag/database` — durable ledger on
Node's built-in `node:sqlite` (ADR-031 amends this section's original
`better-sqlite3` assumption: zero runtime dependencies, native-compilation
avoided on the Windows CI matrix; the Repository/AuditSink/TransactionScope
ports keep a driver swap a leaf change). Implemented tables are
`approval_requests` (branded ids, immutable scope columns, `revision` for
CAS, decision/failure columns + CHECK coherence) and `audit_events`
(seq/autoincrement, canonical sorted-key `detail_json`, indexed by
request); `PRAGMA user_version` drives forward-only migrations (ADR-032);
WAL + `synchronous=FULL` + `quick_check`-on-open + 5 s busy timeout make
committed decisions durable and corrupt DBs serve nothing. The sketch below
is superseded by the migrations file, kept only as the design intent:

**Embedded SQLite** via `better-sqlite3` (ADR-009) — synchronous API (matches
the single-threaded concurrency model, §18), zero server ops, transactional,
and durable enough to survive process death. Schema sketch:

```sql
requests(
  id TEXT PRIMARY KEY,            -- uuidv7, sortable
  status TEXT NOT NULL,           -- pending|approved|denied|expired|cancelled|abandoned|undelivered
  machine_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,            -- claude-code|codex|kilo|…
  action_digest TEXT NOT NULL,    -- redacted summary
  action_hash TEXT NOT NULL,      -- sha256 of raw payload (never stored raw)
  decision_token_hmac TEXT,       -- expected proof for channel intake
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  decided_at INTEGER, decided_by TEXT,
  version INTEGER NOT NULL DEFAULT 0   -- optimistic lock / idempotency
);
audit_log(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, event TEXT NOT NULL,
  request_id TEXT, actor TEXT, detail_json TEXT NOT NULL  -- pre-redacted
);
policy_overrides(...)  -- future: learned scopes from explicit operator commands
```

- **Raw agent payloads are never persisted** — only digests and hashes.
- WAL mode; `synchronous=FULL` for the two writes on the decision path
  (audit-before-deliver, §17).
- Retention: resolved requests compacted after 30 days into
  `requests_archive`; the audit log is append-only and never rewritten; DB file
  is `0600`, excluded from backups containing secrets by documentation note.
- Repository is behind `Repository` port; an in-memory impl ships with Phase 1
  for tests/dev (ADR-010).

## 12. Authentication

Identities the system authenticates, and how:

| Principal                  | Where           | Mechanism                                                                                                                          |
| -------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Telegram operator**      | channel intake  | `callback_query.from.id` ∈ configured allowlist **and** HMAC token embedded in the callback data. No password, no "chat text" auth |
| **Agent session (local)**  | loopback        | Same-user local process + startup bearer token file (mode `0600`) required on every request                                        |
| **Remote gateway (relay)** | relay transport | Provisioned 256-bit key per gateway, HMAC-signed frames over TLS; rotation = edit config both ends, restart                        |
| **Telegram bot itself**    | outbound API    | Bot token from env/config; never transmitted onward                                                                                |

Bootstrap of operator allowlist: operator sends `/start` to the bot; the
gateway logs the numeric user ID but **denies all actions** until the human
edits the ID into config and restarts (no "first user wins" auto-binding —
that would be an open door on any machine where someone finds the bot username).

## 13. Authorization

Distinct from authentication — _who may decide what_:

- Only the allowlisted operator chat may resolve requests. All callbacks from
  other IDs are rejected and audited.
- **Scoping:** a decision is only valid for the exact `requestId` it references;
  request scoping (`machine/project/session`) is fixed at submit time and
  immutable. The operator sees and acts on individual requests — there is no
  blanket "approve all from machine X" in v1.
- **Policy precedence (deny-first):**
  `local explicit deny rule` > `expiry/absent state (fail closed)` >
  `explicit auto-allow rule` > `human decision` > `default pending→expire→deny`.
  A deny rule in local config can **never** be overridden remotely — there is
  no Telegram verb that mutates policy state in v1 except `/cancel` of a
  pending request (which is a safe direction).
- Auto-allow rules exist but require the operator to write them locally;
  defaults ship empty.

## 14. Approval Lifecycle

Phase 2 IMPLEMENTED (ADR-019 reconciles this section's earlier draft names).
A request exists in exactly one of eight states, keyed by a globally unique,
brand-validated `requestId`, correlated to the caller by `correlationId`, and
carrying a core-stamped TTL (default 120 s, hard max 1 h):

```
created ──persisted──► pending ──┬─ decided:allow* ──► approved   (terminal)
   │                             ├─ decided:deny|stop► denied    (terminal)
   │ (durable insert)            ├─ clock ≥ expires ─► expired    (terminal, ≡ deny)
   │                             ├─ cancelled ───────► cancelled  (terminal, ≡ deny)
   │                             ├─ origin lost ─────► agent-disconnected (terminal, ≡ deny)
   └───────── failed ────────────┴─ infrastructure ──► failed     (terminal, deny-equivalent)
```

Mapping from the original draft: `submitted`→`created`, `abandoned`→
`agent-disconnected`; `delivered`/`undelivered`/`closed` are **application
audit events** (`request-resolved` + delivery events in later phases), not
domain states — terminality of `approved`/`denied` is absolute, while
"delivered or not" remains observable in the audit stream (§17).

- `created`: validated + durably inserted, not yet promptable; `pending`:
  prompt path. Only `pending` is resolvable.
- Every transition is immutable (functional update), bumps `version`, and the
  store write is a version-checked compare-and-swap.
- Restart recovery: unresolved pendings expire by their own TTLs; expiry is
  evaluated exclusively against the core `Clock` (§15 guards).

## 15. State Machine

Implemented as a pure reducer in `@raag/domain/machine.ts` — no I/O, no
clocks it owns, exhaustive and property-tested:

| From            | Event                                | To                 | Kind                                |
| --------------- | ------------------------------------ | ------------------ | ----------------------------------- |
| created         | persisted                            | pending            | advance (version+1)                 |
| created/pending | failed                               | failed             | advance (deny-equivalent)           |
| pending         | decided (allow-once/allow-session)   | approved           | advance                             |
| pending         | decided (deny/stop-agent)            | denied             | advance                             |
| pending         | expired (now ≥ expiresAt, inclusive) | expired            | advance                             |
| pending         | cancelled                            | cancelled          | advance                             |
| pending         | agent-disconnected                   | agent-disconnected | advance                             |
| terminal        | same decision                        | —                  | `duplicate` (no effect, idempotent) |
| approved/denied | differing decision                   | —                  | `conflict` (state frozen)           |
| terminal        | any non-decision event               | —                  | `no-change`                         |
| non-pending     | lifecycle probes                     | —                  | `rejected` (typed reason)           |

Transition guards (all checked inside the core, single-writer; §7/§17):

1. Current state must be in the source set of the event — **no self-loops, no
   skipping**; rejection is a typed outcome, not an exception, so the manager
   audts classification without exception plumbing.
2. `now < expiresAt` for decision events with `now` supplied by the core
   Clock at event time; the expiry boundary is **inclusive** (ADR-019):
   `now == expiresAt` can no longer be approved. Late/expired decisions are
   never re-applied after restart either (post-restart they read `unknown`
   against an empty store and expire closed).
3. Optimistic `version` CAS at the repository (defense-in-depth above the
   single-writer loop; §18; the DB phase upgrades this to transactional).
4. **Unknown events or states → reject + audit.** Absence of an accepted
   transition is always a deny to the agent — fail-closed is structural.
5. **Audit-before-store** for every decision transition: if the durable audit
   append fails, the store is never written; the approval cannot exist without
   its record (ADR-019; implemented in `ApprovalManager` and tested).

`expired`, `cancelled`, `agent-disconnected` and `failed` are
**deny-equivalent**: delivery code (§19 adapters/transport) maps all four to a
native denial; `approved`/`denied` are the only states whose audit trail says
"human/policy resolved this".

## 16. Security Boundaries

Three zones; every arrow crosses a validation gate (full rules in
[security.md](../security.md)):

```
ZONE A (trusted, local)     ZONE B (quasi-trusted, local)   ZONE C (untrusted)
core, policy, audit,  ◄──►  adapters, loopback listener,  ◄──►  Telegram network
repository                  channel SDK boundary                input, agent hook
                                                                payloads, relay bytes
```

- **Boundary A↔C (Telegram):** only callback tokens + fixed commands enter;
  identity = chat-ID allowlist + HMAC; text from humans is display-only. No
  channel input can create rules, select files, name commands, or trigger
  anything other than resolve/cancel/list operations.
- **Boundary B↔C (agents):** hook payloads schema-validated, size-capped,
  same-user enforced; agent data is rendered to humans only through redaction
  (`shared/redaction/` strips `.env`-style keys, tokens, PEM blocks, high-entropy
  strings) — the raw payload exists only transiently in adapter memory for
  hashing.
- **Boundary A↔B inside the box:** adapters/channels interact with the core
  **only** through port interfaces submitting typed events; the core validates
  every event against the state machine regardless of which component sent it
  (defense in depth — a compromised adapter cannot forge `approved` without the
  HMAC it cannot know).
- **Secrets:** bot token, HMAC key, relay keys live in local config/env; never
  in DB, never in audit JSON, never in Telegram traffic (§ security.md
  "Secrets").
- **No execution primitive:** the codebase defines no function that maps
  "message received" → "spawn/process". The audit logger, policy engine, and
  channel contain zero child-process APIs; this is enforced by review + Phase 3
  dependency lint (ADR-004).

## 17. Failure Handling

**Fail closed is the default for every unhandled branch.** Specifics:

| Failure                                           | Behavior                                                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram send fails / rate-limited                | retry w/ backoff bounded by TTL; on expiry → request expires = deny; operator-visible `/pending` gap is acceptable, silent allow is not |
| Callback HMAC mismatch / non-allowlist chat       | reject, answer "unauthorized", audit; never changes request state                                                                       |
| Process crash with pending requests               | on restart, all non-terminal states reconcile to `expired` (deny) — stale requests cannot be approved post-restart by design            |
| Decision computed but delivery fails (agent gone) | `undelivered` + audit; agent's own prompt timed out natively → local deny                                                               |
| Audit write fails                                 | request transition aborted and reverted → pending → expired → deny (durability of the record is on the allow path's critical chain)     |
| Policy engine error                               | treated as NEED_HUMAN at best; never ALLOW                                                                                              |
| Relay disconnect                                  | in-flight requests expire by TTL; buffered submits flush on reconnect _only while still within their original TTL_ — never re-arm       |
| DB corrupted / unreadable                         | refuse to start serving approvals (fail closed: cannot prove request state ⇒ cannot allow)                                              |
| Duplicate/late callbacks                          | state-machine guards make them no-ops (idempotent)                                                                                      |
| Clock skew                                        | TTL uses monotonic clock internally; wall clock only for display                                                                        |

There is **no code path where an infrastructure error produces
`permissionDecision: allow`.**

## 18. Concurrency Model

- **Single process, single writer.** The Approval Core is one Node event loop;
  all state transitions flow through a serialized async command queue
  ("decision lane") so the state machine sees events one at a time — no
  locks inside the domain. `better-sqlite3` synchronous writes run inline on
  this lane (microsecond-scale, WAL).
- I/O-bound fan-out happens _outside_ the lane: Telegram polling, adapter
  listeners, and long-poll waiters are async; they enqueue events.
- **Idempotency & duplicate suppression:** every transition carries
  `expectedVersion`; a stale-version submit is rejected before touching state,
  making "tap Approve twice, from two phones" provably safe.
- Many concurrent requests are normal (N agents × M sessions). The lane
  operation is O(1)-work per event, so throughput is bounded by I/O, not
  coordination. Expiry sweep is a single timer (min-heap by `expires_at`) on
  the same lane — no polling loops.
- No worker threads or clustering in v1; the scale-up path (if ever needed) is
  sharding gateways per machine scope, not parallelizing the core.

## 19. Deployment Model

**Topology A — single machine (default):**
One `gateway` process on the operator's workstation/VM. Adapters' hook shims
talk to it via loopback/IPC; it polls Telegram. Agents on the same box.
Simplest path, covers personal use.

**Topology B — split host + agent gateways:**
A `host` process (server, always-on) owns SQLite, Telegram, policy, and audit.
Thin `gateway` processes on agent machines run adapters + loopback and connect
outbound over the relay (§10). The human's experience is identical.
No listening ports opened on agent machines; host port is TLS-only with
per-gateway keys.

**Runtime:** bare `node dist/gateway/main.js` under any supervisor (systemd,
PM2, Task Scheduler — not packaged by us in v1). Configuration: single
`config.yaml` + env vars for secrets (`TELEGRAM_BOT_TOKEN`, `APPROVAL_HMAC_KEY`,
`RELAY_KEY_*`). Healthcheck: `GET /healthz` on loopback (status + drift metrics).
First-party deploy docs out of scope for v1.

## 20. Extension Model

The system is designed so these futures require **additive code only**:

- **New agent** → implement `AgentAdapter` in a new folder + register in the
  composition root. The core already speaks only `ApprovalRequest`; it must not
  be modified. If a future agent's surface needs a capability the port doesn't
  express (e.g. _interactive option lists_ rather than allow/deny), the port is
  extended **additively** (optional method + capability descriptor
  `AgentAdapter.capabilities`), with core defaults preserving old semantics.
- **New notification channel** (e.g. Signal push, SMS) → implement
  `NotificationProvider` + `ApprovalChannel`; policy and core are untouched;
  channels compose (notify-all / decide-any-wins-first with version guard).
- **New transport** → implement `Transport`.
- **Adapters/channels may be authored outside this repo** (third-party npm
  packages exporting a class implementing the published port interfaces);
  `ports/` will be structured so it can be published as
  `@raag/ports` without moving the monolith (ADR-012).
- **Policy backends** → `PolicyEngine` is a port; adding a remote/CAS-based
  policy source is a new impl, not a core change.

Anti-gardening clause: every new interface must be justified by ≥2 concrete
implementations or a committed Phase 1–3 need, otherwise keep it as a plain
function (avoid speculative abstraction).

## 21. Future Web UI Boundary

A read/write web dashboard may exist _someday_, but the architecture keeps it
out of v1 deliberately. Boundary rules that make that safe later:

- The **Approval Core + state machine are UI-agnostic** — a web UI would be
  _yet another `ApprovalChannel`_ consuming the same validated decision events.
  Nothing about Telegram appears in the domain, so swapping/adding UIs never
  touches the state machine.
- A future web UI MUST sit behind real authentication (not chat-ID trust),
  MUST NOT add new decision types the state machine doesn't already accept,
  and MUST reuse the same audit and policy paths. It gains no capability that
  Telegram lacks — same `resolve/cancel/list` surface, no "approve everything,"
  no config mutation.
- Until then: `docs/architecture.md` §21 is the contract; no web code exists,
  no framework is preselected, and no component may assume the _only_ channel
  is Telegram (channel-agnostic types only in ports).

---

## Dependency rule (enforced since Phase 2 by type-aware ESLint + purity meta-test)

```
core/  ──►  ports/  only
policy/, audit/, transport/*, channels/*, adapters/*  ──►  ports/ + core types
main.ts (composition root)  ──►  everything
anything else  ──X──►  telegram SDK, sqlite driver, agent SDKs, http framework
```
