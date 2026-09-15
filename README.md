# Remote Agent Approval Gateway (v1)

Secure, extensible remote human-approval gateway for AI coding agents.

Agents (Claude Code, Codex, Kilo Code) emit permission requests through native
integrations. A **local gateway** on the agent machine forwards them to the
**Approval Core**, which evaluates policy and prompts a human over **Telegram**
— the only remote UI in v1. Decisions flow back through the local gateway to
the originating agent. The gateway **never executes commands**; Telegram
carries opaque approval tokens only, and every failure resolves to deny
(fail-closed).

## Status

- **Phase 0 — architecture: done** ([docs/architecture.md](docs/architecture.md))
- **Phase 1 — repository bootstrap: done**
- **Phase 2 — core foundation: done** — framework-independent domain (8-state
  lifecycle machine, decision scopes, branded IDs, risk), the `ApprovalManager`
  application service, in-memory repository (explicitly not crash-persistent),
  validated fail-closed config, redaction + structured logging, untrusted-input
  protocol DTOs, and the Claude Code adapter **skeleton only**. See
  [progress.md](progress.md) for exact test/coverage numbers.
- **NOT implemented (planned later phases):** Telegram bot/UI, real agent
  integration, HTTP/relay transports, SQLite, policy engine, E2E.

| Document                                     | Purpose                                       |
| -------------------------------------------- | --------------------------------------------- |
| [docs/architecture.md](docs/architecture.md) | Canonical architecture (start here)           |
| [security.md](security.md)                   | Security model, boundaries, fail-closed rules |
| [decisions.md](decisions.md)                 | Architecture Decision Records (ADRs)          |
| [testing.md](testing.md)                     | Testing strategy (Vitest tiers)               |
| [progress.md](progress.md)                   | Phase log and current status                  |

## Repository structure

```
apps/
  cli/                  operator CLI (install/configure/doctor) — placeholder
  local-gateway/        main process / composition root — placeholder
  relay/                multi-machine relay host — placeholder
  telegram-bot/         split-deployment bot process — placeholder
packages/
  domain/               ✅ types, ports, 8-state machine (imports nothing external)
  application/          ✅ ApprovalManager + interaction ports
  core/                 facade barrel for apps — placeholder wiring
  adapters/claude-code/ 🦴 SKELETON ONLY (normalization; no agent integration)
  adapters/…            codex/ kilo-code/ generic/ — placeholder; + registry barrel
  telegram/             Telegram channel — NOT IMPLEMENTED (only SDK-allowed package)
  policy/               NOT IMPLEMENTED (Phase 3)
  security/             ✅ redaction (string + structural)
  database/             ✅ in-memory repository; SQLite in DB phase
  protocol/             ✅ untrusted-input validated DTOs (no transports yet)
  config/               ✅ fail-closed env validation (loopback bind, HMAC entropy)
  logging/              ✅ redacting structured logger
  testing/              ✅ fake clock, fixtures, repository conformance suite
tests/
  unit/ integration/ security/ e2e/ fixtures/
docs/architecture.md    canonical architecture
```

## Commands

| Command                           | What it does                                      |
| --------------------------------- | ------------------------------------------------- |
| `npm install`                     | link 20 workspaces, install dev toolchain         |
| `npm run typecheck`               | `tsc -b --force` + noEmit check incl. tests       |
| `npm run lint` / `lint:fix`       | type-aware ESLint (incl. architecture rules)      |
| `npm run format` / `format:check` | Prettier                                          |
| `npm test`                        | Vitest: unit + integration + security tiers       |
| `npm run test:coverage`           | same + ADR-029 coverage floors (what CI enforces) |
| `npm run build`                   | `tsc -b` → `dist/` in every package               |
| `npm run check`                   | full CI chain locally (incl. coverage)            |
| `npm run clean`                   | remove build outputs                              |

## Requirements

Node.js ≥ 22, npm 10+. Real Telegram/agent functionality arrives in later
phases — see [progress.md](progress.md).
