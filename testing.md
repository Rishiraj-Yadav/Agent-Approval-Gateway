# Testing Strategy

Framework: **Vitest 5** (ADR-015), configured in `vitest.config.ts` with one
_project_ per tier so tiers can be run independently

```
npm test                       # unit + integration + security tiers
npm run test:coverage          # same tiers + ADR-029 floor enforcement (used by CI)
npm run test:watch             # unit tier in watch mode
npm run test:unit              # unit tier only
npm run test:integration       # integration tier only
npm run test:security          # security tier only
npm run test:e2e               # requires npm run build; tier exists but has no tests yet (Phase 7+)
```

Two homes for tests:

- `tests/<tier>/` — cross-package suites per this document.
- `packages/<pkg>/tests/*.test.ts` — package-local tests, collected into the
  **unit tier** automatically (vitest projects include both). A package's
  invariants live next to it and cannot be forgotten by the CI matrix.

Layout (spec-mandated directories exist pre-populated for Phase 1+):

```
tests/
  unit/         pure logic, no I/O            (tier: unit)
  integration/  ports↔adapters, repo conformance, transports (tier: integration)
  security/     attack/abuse cases            (tier: security)
  e2e/          full gateway with a mocked Telegram API (tier: e2e)
  fixtures/     shared JSON payloads: agent hook samples, callback samples
```

Tiers are defined by `test.projects[].include` on the `tests/<tier>/**`
directory — adding a `.test.ts` file is enough to make it a member of its
tier; no test-name magic.

## What gets tested, per phase

| Phase                         | Coverage targets / status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**                         | ✅ done — foundation integrity: workspaces resolve, type-check/build, strictness flags, dependency-rule lint, Windows+Linux CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **2**                         | ✅ done — domain state machine (exhaustive duplicate/late/stale/expiry tests + inclusive boundary, fake `Clock`); repository conformance suite; config (loopback bind refusal, HMAC entropy, no-value errors); redaction (API keys, bearer, bot tokens, nested, unknown-safe); logger levels+redaction; protocol untrusted-input parsing; manager ingress paths                                                                                                                                                                                                                                                         |
| **2 security tier**           | ✅ non-loopbind refusals, secret-free config errors, idempotency/double-decision, lifecycle-script hygiene, listener-scope scan; updated in Phase 3 (below)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **3 (Phase 3 — done)**        | ✅ SQLite: migrations (fresh/reopen/future-schema/corruption), pragmas, CAS races + immutable pinning, audit-transaction rollback, tampered-row hydration fail-closed; conformance runs BOTH stores; restart/reconcile via close/reopen (deterministic fake clocks, file-backed); local gateway: envelope auth (forged MAC, replay nonce, stale/future ts), scope impersonation, waiter isolation/capacity/cleanup, shutdown never-decision, socket framing+oversize+connection caps, IPC-only guarantee (no ports anywhere; loopback config still enforced); 247 tests, real Windows/POSIX pipes/sockets in the matrix |
| **3 (integration, deferred)** | Adapter contract tests per agent using `tests/fixtures/` recorded native payloads (Phase 4 — the Claude hook _runtime_ is still absent); relay pair reconnect/expiry deferred with the relay phase                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **4/5 (domain-adjacent)**     | Policy engine deny-first + audit-failure → deny (done for sqlite atomic case; rules engine absent); expiry-scheduler (sweeper interval exists); restart reconciliation ✅ done in Phase 3                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **6+ (e2e)**                  | Gateway process with Telegram API faked (no network ever in tests): submit → prompt → callback → decision → delivered; crash-mid-decision recovery (reconciliation now covers DB reopen; process-kill fixtures pending)                                                                                                                                                                                                                                                                                                                                                                                                 |
| **6+ (perf/soak)**            | 1k concurrent pendings, callback-storm duplicates — bounded latency, zero double-effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Rules

1. **No real network in tests** — Telegram/agent SDKs are behind ports and
   faked; CI has no secrets to leak. Exception since Phase 3: the gateway's
   OWN local IPC (named pipe / UDS) is exercised for real in integration
   tests (localhost-only, OS-private, no remote reachability).
2. **Deterministic time** — everything takes `Clock` from `packages/testing`
   (production `createFakeClock`/`createSystemClock`); expiry tests never
   rely on wall-clock timing.
3. A security regression must land with two artifacts: a `tests/security/`
   test _and_ an ADR entry or update.
4. Coverage floors (ADR-029, vitest global thresholds, CI-enforced):
   90 % lines/stmts/functions, 85 % branches across all included `src`
   (barrels excluded; `packages/testing` + bootstrap `main.ts` excluded —
   see ADR-029 rationale; Phase 3 added `apps/*/src` to the measured set —
   gateway code counts for real). Current: 90.6/85.7/95.5/93.0.

## What is NOT tested automatically (manual checklist, Phase 4)

- Real Telegram tap-through on a phone; OS keychain/`0600` file permission
  behavior on a fresh user; Windows/Linux supervisor restart.
