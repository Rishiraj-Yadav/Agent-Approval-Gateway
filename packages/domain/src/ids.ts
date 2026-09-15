/**
 * Opaque, branded identifiers.
 *
 * Every ID family is a distinct TypeScript brand so e.g. a `machineId` can
 * never be passed where a `requestId` is expected without an explicit
 * validated conversion. Runtime parsing enforces the shape; values are
 * treated as opaque strings everywhere else.
 */
import { DomainError } from './errors.js';

declare const brandSymbol: unique symbol;
export type Brand<TKind extends string> = { readonly [brandSymbol]: TKind };
export type OpaqueId<TKind extends string> = string & Brand<TKind>;

export type RequestId = OpaqueId<'request'>;
export type CorrelationId = OpaqueId<'correlation'>;
export type MachineId = OpaqueId<'machine'>;
export type SessionId = OpaqueId<'session'>;
export type ProjectId = OpaqueId<'project'>;
export type AgentId = OpaqueId<'agent'>;

/**
 * Common opaque-ID shape: 1–128 chars, `[A-Za-z0-9]` start, then
 * `[A-Za-z0-9._:-]*`. UUIDv7 (request ids) and Claude-style session UUIDs
 * both fit; shell metacharacters, whitespace, and path separators do not —
 * IDs must be safe raw string content anywhere (logs, callback data).
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function parseId(kind: string, field: string, raw: string | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new DomainError('invalid-id', field, `${kind} id must be a non-empty string`);
  }
  if (!ID_PATTERN.test(raw)) {
    throw new DomainError(
      'invalid-id',
      field,
      `${kind} id must be 1-128 chars of [A-Za-z0-9][A-Za-z0-9._:-]*`,
    );
  }
  return raw;
}

export function parseRequestId(raw: unknown): RequestId {
  requireString('requestId', raw);
  return parseId('request', 'requestId', raw) as RequestId;
}
export function parseCorrelationId(raw: unknown): CorrelationId {
  requireString('correlationId', raw);
  return parseId('correlation', 'correlationId', raw) as CorrelationId;
}
export function parseMachineId(raw: unknown): MachineId {
  requireString('machineId', raw);
  return parseId('machine', 'machineId', raw) as MachineId;
}
export function parseSessionId(raw: unknown): SessionId {
  requireString('sessionId', raw);
  return parseId('session', 'sessionId', raw) as SessionId;
}
export function parseProjectId(raw: unknown): ProjectId {
  requireString('projectId', raw);
  return parseId('project', 'projectId', raw) as ProjectId;
}
export function parseAgentId(raw: unknown): AgentId {
  requireString('agentId', raw);
  return parseId('agent', 'agentId', raw) as AgentId;
}

function requireString(field: string, raw: unknown): asserts raw is string {
  if (typeof raw !== 'string') {
    throw new DomainError('invalid-id', field, 'must be a string');
  }
}
