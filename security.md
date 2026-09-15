# Security Model

> Canonical threat model and mandatory rules. Cross-references:
> [docs/architecture.md](docs/architecture.md) (§12–17) ·
> [decisions.md](decisions.md) (ADRs 004, 006, 007, 008).

## 1. Invariants (non-negotiable)

1. **Fail closed.** The absence of a fresh, authorized, durable `allow` is a
   `deny`. No infrastructure error — crash, timeout, DB failure, transport
   loss, unknown state, clock skew — can produce `allow`.
2. **No auto-approval on infrastructure failure** — a corollary with teeth:
   retries may re-deliver _human_ decisions; they may never synthesize one.
3. **No command execution inside the gateway.** Telegram input (or any remote
   input) is data — a request id and an allow/deny bit. There is no spawn/exec
   path reachable from any channel or hook handler. Enforced by code review and
   a Phase 3 lint rule banning child-process APIs outside `adapters`.
4. **Telegram callback data is untrusted.** Valid only with (a) sender chat id
   in the operator allowlist and (b) a verified HMAC token bound to the exact
   `requestId` + decision. Text, forwarded messages, and edits are never
   decision input.
5. **Agent-generated data is untrusted.** Hook payloads are schema-validated,
   size-capped, and never rendered to the operator raw — only through the
   redaction pipeline; the raw bytes are hashed (SHA-256) and discarded.
6. **Authorization is mandatory.** Authentication (who) and authorization
   (what they may decide) are separate checks on every decision event; both
   must pass inside the core state machine, not in the channel.
7. **Requests expire.** Default TTL 120s, monotonic-clock evaluated by the
   core. Post-expiry decisions are rejected; expired ⇒ deny to the agent.
   Stale requests cannot be approved after restart (reconciled to `expired`).
8. **Approvals are idempotent.** A resolve on a non-pending request returns its
   current terminal state; no side effects, no double-delivery. Duplicate
   callbacks cannot approve twice (version-guarded CAS transition).
9. **Local deny rules are irrevocable remotely.** No Telegram verb mutates
   policy; explicit deny short-circuits before a human prompt is ever sent.
10. **Secrets never reach Telegram** — bot tokens, HMAC keys, relay keys, agent
    env vars — **and never appear in logs or the audit log.** Redaction runs
    before logging; the audit `detail_json` is written from a pre-redacted
    projection.
11. **The gateway only ever approves actions the agent's own permission system
    would accept from a local human** — it cannot widen native permissions.

## 2. Trust boundaries

| Zone                       | Contents                             | Trust                                     | Guard                                                        |
| -------------------------- | ------------------------------------ | ----------------------------------------- | ------------------------------------------------------------ |
| Remote                     | Telegram network, other users' chats | hostile                                   | allowlist + HMAC + state machine                             |
| Agent process              | hook payloads, CLI output            | quasi-hostile (buggy/compromised machine) | schema + size cap + redaction + hashing; same-user IPC token |
| Local gateway peers (§2b)  | pipe/UDS frame traffic               | authenticated-by-HMAC, still untrusted    | envelope + replay guard + scope re-check + strict protocol   |
| Local adapter/channel code | runs on gateway host                 | quasi-trusted                             | submits typed events only; core re-validates everything      |
| Core + policy + storage    | decision truth                       | trusted                                   | single-writer lane; atomic CAS+audit in one txn (ADR-030)    |

Defense in depth: even if the Telegram channel layer were fully compromised,
the attacker cannot forge `resolve()` without the HMAC secret; even if an
adapter were compromised, it cannot create a pending-without-request or mark
auto-allow against a deny rule (policy lives in core-side ports the adapter
never calls).

## 3. Attack scenarios and why they fail

- **`/start`-time stranger takes over:** first user is _logged but denied_;
  binding requires manual config edit + restart.
- **Replay an intercepted callback:** request already terminal → no-op
  (idempotent); TTL window makes replay irrelevant past expiry anyway.
- **Approve-by-name spoofing (lookalike chat):** identity is numeric chat id,
  not display name.
- **Prompt-injection through `action_summary`** ("approve this, it's safe"):
  summary is display-only, truncated, and the operator can always `deny`; raw
  text is never an input.
- **Relay/MITM:** outbound-only TLS with per-gateway keys + signed frames.
- **Loopback port scan from LAN:** bind is loopback-only; non-loopback startup
  is fatal.
- **Fill-disk to block the audit log:** audit-write failure aborts the pending
  transition, which then expires → deny (failure mode is availability, never
  authorization).
- **Malicious agent payload → SQL:** repository uses prepared statements only;
  raw payloads aren't persisted.

## 4. Secrets handling (Phase 2 — IMPLEMENTED in `@raag/config` + `@raag/security`)

- Sources: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`,
  `APPROVAL_HMAC_KEY`, `RELAY_GATEWAY_KEY` — env only, never a config file,
  never committed (`.gitignore` covers `.env*`; `.env.example` carries empty
  placeholders checked by `tests/security/fail-closed.test.ts`).
- `parseConfig`/`loadGatewayConfig` validate at startup and FAIL CLOSED with
  field-name-only errors (no values echoed — asserted by tests):
  - `APPROVAL_HMAC_KEY`: non-empty, ≥32 characters, not trivially
    (single-repeated) or placeholder-words, Shannon ≥3.5 bits/char
    ("entropy floor chosen; exact algorithm documented in ADR-024 — it is
    a sanity gate, not a strength proof; generated 32-byte random keys pass
    easily and this is documented in `.env.example` comments on use of
    `openssl rand -hex 32`-style generation);
  - `GATEWAY_HOST`: exactly `127.0.0.1`, `localhost` or `::1` — ANY other
    literal, including `0.0.0.0` and `::`, is a hard fatal error (never
    downgraded). `GATEWAY_PORT` bounded 0..65535;
  - `APPROVAL_TTL_SECONDS`: 1..3600 (cap documented ADR-023; default 120);
  - Relay pairs all-or-nothing, https only.
- `packages/security` exports deterministic+idempotent `redactString` /
  `redactUnknown` (patterns: PEM/JWT/bot tokens/AWS/bearer/authorization
  headers/sensitive kv/long base64) plus sensitive FIELD-name replacement in
  nested structures. **Limit, stated openly:** pattern-based redaction is
  best-effort; the structural guarantees (payloads hashed and discarded,
  secrets never routed through these functions, callbacks carrying only opaque
  HMAC-bound tokens not text) are primary.

### 4b. Local gateway authentication + replay (Phase 3 — IMPLEMENTED, ADR-034)

- Transport is **local IPC only** (Windows named pipe / POSIX UDS with a
  mode-`0600` socket under the per-user name). No TCP listener exists in the
  gateway at all: LAN exposure is structurally impossible, not merely
  disallowed by config.
- **Every inbound frame** must satisfy, in order: size cap (256 KB) →
  exact-key envelope shape → `HMAC-SHA256(GATEWAY_LOCAL_KEY,
"raag.local|ts|nonce|canonicalMessage")` verified with a constant-time
  compare → freshness guard (|now-ts| ≤ ±60 s; seen nonces rejected FIFO in a
  cache bounded at 4096) → scope re-check (stored `machineId` +
  `correlationId` must match — mismatches return a uniform `unknown-request`,
  so one local caller cannot probe/act on another scope).
- Tampered body fields, forged/wrong-key signatures, replayed frames (same
  nonce), stale/future timestamps, malformed/unknown field sets: **all fail
  closed; none ever reaches the application layer, and none can flip a
  terminal state.** Auth faults close the connection.
- `GATEWAY_LOCAL_KEY` is required and validated with the ADR-024 entropy
  rules; it never appears in logs/errors/audit/response frames, and response
  frames carry identifiers + stable reason codes only.
- Restart/reconciliation cannot approve (§12 of the spec; ADR-033); shutdown
  releases waiters without any decision.
- Honest note: the local key is a shared secret within the user's trust
  domain — it authenticates frames and blocks accidental/replay misuse (and a
  non-key local process without pipe/ACL access); OS user separation remains
  the boundary (ADR-034 explicitly records this; it is not a hardening gap
  being papered over).

## 5. What the gateway will never do (v1)

Add users, change policy, read files, run commands, persist raw payloads,
approve post-expiry, approve across scopes, or expose itself over the network;
it may talk only to local IPC peers (once the channel phases land: Telegram +
configured relays), and the gateway process itself never executes agent
commands.
