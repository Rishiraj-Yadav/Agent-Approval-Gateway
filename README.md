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
- **Phase 1 — repository bootstrap: done** (monorepo, strict TS, lint, format,
  Vitest, CI; zero runtime dependencies — see
  [decisions.md](decisions.md) ADR-013…019)
- **Phase 2+ — no product behavior implemented yet**

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
  domain/               types + ports + state machine (imports nothing)
  application/          Approval Manager use-cases (ports only)
  core/                 facade barrel for apps
  adapters/             claude-code/ codex/ kilo-code/ generic/ + barrel
  telegram/             Telegram channel (only place the SDK may appear)
  policy/ security/ database/ protocol/ config/ logging/ testing/
tests/
  unit/ integration/ security/ e2e/ fixtures/
docs/architecture.md    canonical architecture
```

## Commands

| Command                           | What it does                                |
| --------------------------------- | ------------------------------------------- |
| `npm install`                     | link 20 workspaces, install dev toolchain   |
| `npm run typecheck`               | `tsc -b --force` + noEmit check incl. tests |
| `npm run lint` / `lint:fix`       | ESLint flat config (incl. dependency rules) |
| `npm run format` / `format:check` | Prettier                                    |
| `npm test`                        | Vitest: unit + integration + security tiers |
| `npm run build`                   | `tsc -b` → `dist/` in every package         |
| `npm run check`                   | the whole CI chain locally                  |
| `npm run clean`                   | remove build outputs                        |

## Requirements

Node.js ≥ 22, npm 10+. Real Telegram/agent functionality arrives in later
phases — see [progress.md](progress.md).
