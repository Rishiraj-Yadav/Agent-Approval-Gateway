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
| Local adapter/channel code | runs on gateway host                 | quasi-trusted                             | submits typed events only; core re-validates everything      |
| Core + policy + storage    | decision truth                       | trusted                                   | single-writer lane; audit-before-deliver                     |

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

## 4. Secrets handling

- Sources: `TELEGRAM_BOT_TOKEN`, `APPROVAL_HMAC_KEY`,
  `RELAY_GATEWAY_KEYS` — env only, never config file, never committed
  (`.gitignore` covers `.env*`; `.env.example` carries placeholders).
- Startup validates presence and entropy (≥32 bytes for HMAC key) or exits.
- `packages/security` exports the canonical redaction patterns applied to any
  string before it leaves the process toward Telegram, logs, or DB.

## 5. What the system explicitly cannot do (v1)

Add users, change policy, read files, run commands, persist raw payloads,
approve post-expiry, approve across scopes, or talk to any endpoint other than
api.telegram.org + loopback + configured relays.
