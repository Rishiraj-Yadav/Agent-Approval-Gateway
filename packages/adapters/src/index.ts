/**
 * @raag/adapters — Adapter registry: imports the concrete adapters and exposes them to the composition root only (the import rule's sink).
 *
 * Phase 1 scaffold: placeholders only. Implementation per
 * docs/architecture.md lands in Phase 2+.
 */
import * as claudeCode from '@raag/claude-code';
import * as codex from '@raag/codex';
import * as kiloCode from '@raag/kilo-code';
import * as generic from '@raag/generic';

export const packageName = '@raag/adapters' as const;
export const concreteAdapters = { claudeCode, codex, kiloCode, generic } as const;
