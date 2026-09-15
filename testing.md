# Testing Strategy

Framework: **Vitest 3**, configured in `vitest.config.ts` with one _project_
per tier so tiers can be run independently

```
npm test                       # unit + integration + security (fast, safe default)
npm run test:watch             # unit tier in watch mode
npm run test:unit              # unit tier only
npm run test:integration       # integration tier only
npm run test:security          # security tier only
npm run test:e2e               # requires npm run build first
```

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

| Phase                 | Coverage targets                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1 (now)**           | Foundation integrity: workspaces resolve, every package type-checks and builds, tsconfig strictness flags present, dependency-rule violations caught by lint, all scripts run on Windows + Linux in CI                                                                   |
| **2 (core)**          | State machine: **exhaustive table-driven tests** over every transition × every duplicate/late/stale event → assert legal outcome and idempotence; expiry with an injected fake `Clock` (no wall-clock in tests); repository conformance suite run against in-memory impl |
| **2 (security tier)** | HMAC verify/reject, allowlist reject, replayed callback, approve-after-expiry, approve-after-restart, non-loopback bind refusal, audit-failure → deny path                                                                                                               |
| **3 (integration)**   | Adapter contract tests per agent using `tests/fixtures/` native payloads (recorded, not generated) → normalized request byte-equality; transport (loopback + relay with in-proc pair) reconnect/expiry behavior                                                          |
| **4 (e2e)**           | Gateway process with Telegram API faked (no network in tests ever): submit → prompt → callback → decision → delivered; crash-mid-decision recovery                                                                                                                       |
| **4 (perf/soak)**     | 1k concurrent pending requests, callback storm (duplicates) — assert bounded latency, zero double-delivery                                                                                                                                                               |

## Rules

1. **No real network in tests** — Telegram/agent SDKs are behind ports and
   faked; CI has no secrets to leak.
2. **Deterministic time** — everything takes `Clock` from `packages/testing`.
3. A security regression is required to land with two artifacts: a
   `tests/security/` test _and_ an ADR entry or update.
4. Coverage floors: `packages/domain` ≥ 95 % branches, `packages/policy` ≥ 95 %;
   the rest ≥ 80 % (advisory in Phase 1, enforced via config when real code
   lands).

## What is NOT tested automatically (manual checklist, Phase 4)

- Real Telegram tap-through on a phone; OS keychain/`0600` file permission
  behavior on a fresh user; Windows/Linux supervisor restart.
