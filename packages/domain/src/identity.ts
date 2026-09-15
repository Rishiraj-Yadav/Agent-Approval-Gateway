/**
 * Identity & context value objects.
 *
 * Clear separation, per spec section 4:
 *  - IDENTITY  : validated opaque IDs (security-relevant, immutable).
 *  - DISPLAY   : `displayName`/`displayPath` — presentation only, NEVER used
 *    for authorization or matching; hostile agent data can live here safely.
 *
 * The agent KIND is extensible by pattern (ADR-005/018: new agents must not
 * require core changes) while the shipped v1 kinds are enumerated so mis-typed
 * literals fail.
 */
import { DomainError } from './errors.js';
import {
  parseMachineId,
  parseProjectId,
  parseSessionId,
  type MachineId,
  type ProjectId,
  type SessionId,
} from './ids.js';

export const KNOWN_AGENT_KINDS = ['claude-code', 'codex', 'kilo', 'generic'] as const;
export type KnownAgentKind = (typeof KNOWN_AGENT_KINDS)[number];

/** Unknown/future kinds are still constrained to a lowercase slug pattern. */
const AGENT_KIND_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export type AgentKind = KnownAgentKind | (string & {});

export function parseAgentKind(raw: unknown, field = 'agent.kind'): AgentKind {
  if (typeof raw !== 'string' || !AGENT_KIND_PATTERN.test(raw)) {
    throw new DomainError(
      'invalid-agent-identity',
      field,
      'agent kind must be a lowercase slug [a-z][a-z0-9-]{1,31} (v1 known: ' +
        `${KNOWN_AGENT_KINDS.join(', ')})`,
    );
  }
  return raw;
}

export interface AgentIdentity {
  readonly kind: AgentKind;
  /** Reported agent version. Display/triage metadata — never policy input. */
  readonly version: string;
}

const VERSION_PATTERN = /^[\w.+-]{1,32}$/;

export function createAgentIdentity(raw: {
  readonly kind: unknown;
  readonly version: unknown;
}): AgentIdentity {
  const kind = parseAgentKind(raw.kind);
  if (typeof raw.version !== 'string' || !VERSION_PATTERN.test(raw.version)) {
    throw new DomainError(
      'invalid-agent-identity',
      'agent.version',
      'agent version must be 1-32 chars of [A-Za-z0-9._+-]',
    );
  }
  return Object.freeze({ kind, version: raw.version });
}

export interface MachineIdentity {
  readonly id: MachineId;
  /** Operator-facing label for prompt formatting. Display only. */
  readonly displayName: string;
}

export function createMachineIdentity(raw: {
  readonly id: unknown;
  readonly displayName?: unknown;
}): MachineIdentity {
  const id = parseMachineId(raw.id);
  return Object.freeze({
    id,
    displayName: validDisplay(raw.displayName, 'machine.displayName', 64),
  });
}

export interface ProjectDescriptor {
  readonly id: ProjectId;
  /** Path label for humans. Display only; no filesystem meaning here. */
  readonly displayPath: string;
}

export function createProjectDescriptor(raw: {
  readonly id: unknown;
  readonly displayPath?: unknown;
}): ProjectDescriptor {
  const id = parseProjectId(raw.id);
  return Object.freeze({
    id,
    displayPath: validDisplay(raw.displayPath, 'project.displayPath', 512),
  });
}

export interface SessionContext {
  readonly sessionId: SessionId;
}

export function createSessionContext(raw: { readonly sessionId: unknown }): SessionContext {
  return Object.freeze({ sessionId: parseSessionId(raw.sessionId) });
}

function validDisplay(raw: unknown, field: string, max: number): string {
  if (raw === undefined) return '<unknown>';
  if (typeof raw !== 'string') {
    throw new DomainError('invalid-identifier-set', field, 'display field must be a string');
  }
  // eslint-disable-next-line no-control-regex -- reject control chars BY DESIGN (hostile display data)
  if (raw.length === 0 || raw.length > max || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new DomainError(
      'invalid-identifier-set',
      field,
      `display length must be 1-${max} with no control characters`,
    );
  }
  return raw;
}
