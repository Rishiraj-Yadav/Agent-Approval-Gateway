# Remote Agent Approval Gateway — Development Guide

## Repository

- **Location**: `R:\New folder` (this directory) is the project root.
- **Package manager**: npm 10.9.8 (Node v22.23.2 already on PATH).
- **TypeScript**: strict, `tsc -b` via root `package.json` scripts (project
  references per package; solution at root `tsconfig.json`).
- **ESLint 10 + typescript-eslint 8 (flat config), Prettier 3, Vitest 5
  with tier projects (unit/integration/security/e2e).**
- **npm 10 workspaces** (`packages/*`, `packages/adapters/*`, `apps/*`);
  package spec `*` for internal deps — `workspace:` protocol is not linked
  reliably by npm 10 (ADR in decisions.md).
- **No runtime dependencies — still true.** The SQLite layer uses Node's
  built-in `node:sqlite` (ADR-031). Dev-only tooling additions (eslint 10,
  vitest 5 + `@vitest/coverage-v8`) are recorded in decisions.md (ADR-014/
  015/029); every install must be justified in decisions.md (ADR-017).
- **No git history** yet; CI workflow exists but has not executed remotely.

## Conventions

1. **No Web UI, ever (v1).** React/Next/Electron are explicitly out. Only
   Telegram.
2. **Port-first.** All cross-cutting contracts live in domain/application
   ports; concrete vendor code stays in leaf packages. The domain must never
   import an SDK or adapter.
3. **Fail closed, idempotent, expiring.** These are not "nice to haves" —
   every storage and transport path must honor them.
4. **Defense in depth.** Telegram callback data is treated as hostile even
   while inside the machine. Authorization is mandatory and local-deny rules
   are irrevocable remotely.
5. **One line of code beats one paragraph.** If something can be a stdlib call
   or a one-liner, it is.

## Commands

| Command                 | Purpose                                       |
| ----------------------- | --------------------------------------------- |
| `npm install`           | Install dev toolchain, link workspaces        |
| `npm run typecheck`     | `tsc -b --force` + `tsc -p tsconfig.dev.json` |
| `npm run lint`          | ESLint over all workspaces                    |
| `npm run format`        | Prettier write (`format:check` in CI)         |
| `npm test`              | Vitest unit + integration + security tiers    |
| `npm run test:coverage` | same + enforced coverage floors (CI gate)     |
| `npm run build`         | `tsc -b` → `dist/` per package                |
| `npm run check`         | full CI chain locally                         |
| `npm run clean`         | remove build outputs                          |

## Phase roadmap

- **Phase 0 — Project analysis & architecture** (done): architecture,
  security, decisions, testing docs.
- **Phase 1 — Repository bootstrap** (done): toolchain, workspaces, CI,
  placeholder packages/apps only. **No product implementation.**
- **Phase 2 — Core** (done): domain model, approval state machine, ports,
  in-memory repo, config/security/logging packages.
- **Phase 3 — Durable persistence & local gateway foundation** (done):
  `node:sqlite` store + migrations + atomic CAS/audit transactions, restart
  reconciliation, local IPC (pipe/UDS) with HMAC envelope auth + replay
  guard, waiters/shutdown, `apps/local-gateway` composition.
- **Phase 4 — Adapters**: Claude Code hook runtime + recorded fixtures,
  Codex, Kilo, generic adapters; policy engine; transports.
- **Phase 5+ — Channel/Hardening**: Telegram channel (ADR-011), E2E flow,
  production config.
