import { DomainError } from './errors.js';
import { parseCorrelationId, parseRequestId, type CorrelationId, type RequestId } from './ids.js';
import { parseMillis, type Millis } from './time.js';

/**
 * Audit event factory. Details must be *already redacted* scalars; anything
 * object-valued, oversized, or control-character bearing is rejected — the
 * audit pipeline can only ever carry what this file admits.
 */

export const AUDIT_EVENT_TYPES = [
  'request-created',
  'request-pending',
  'request-resolved',
  'request-expired',
  'request-cancelled',
  'request-agent-disconnected',
  'request-failed',
  'state-changed',
  'decision-duplicate',
  'decision-conflict',
  'decision-after-expiry',
  'decision-rejected',
  'submit-rejected',
  'policy-evaluated',
  'notification-failed',
  'state-write-conflict',
  'request-unknown',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const AUDIT_ACTORS = [
  'manager',
  'policy-engine',
  'notification-provider',
  'expiry-monitor',
  'repository',
  'system',
] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];

export const AUDIT_SEVERITIES = ['info', 'warn', 'error'] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

export type AuditDetailValue = string | number | boolean;
export type AuditDetail = Readonly<Record<string, AuditDetailValue>>;

const DETAIL_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,47}$/;
const MAX_DETAIL_KEYS = 16;
const MAX_STRING_VALUE = 256;

export interface AuditEvent {
  readonly type: AuditEventType;
  readonly occurredAt: Millis;
  readonly actor: AuditActor;
  readonly severity: AuditSeverity;
  readonly requestId?: RequestId;
  readonly correlationId?: CorrelationId;
  readonly detail: AuditDetail;
}

export interface NewAuditEventInput {
  readonly type: unknown;
  readonly occurredAt: unknown;
  readonly actor: unknown;
  readonly severity?: unknown;
  readonly requestId?: unknown;
  readonly correlationId?: unknown;
  readonly detail?: unknown;
}

export function createAuditEvent(input: NewAuditEventInput): AuditEvent {
  const type = parseAuditEventType(input.type);
  const occurredAt = parseMillis(input.occurredAt, 'audit.occurredAt');
  const actor = parseAuditActor(input.actor);
  const severity: AuditSeverity =
    input.severity === undefined ? 'info' : parseAuditSeverity(input.severity);
  const requestId = input.requestId === undefined ? undefined : parseRequestId(input.requestId);
  const correlationId =
    input.correlationId === undefined ? undefined : parseCorrelationId(input.correlationId);
  const detail = validateDetail(input.detail ?? {});

  return Object.freeze({
    type,
    occurredAt,
    actor,
    severity,
    ...(correlationId === undefined ? {} : { correlationId }),
    ...(requestId === undefined ? {} : { requestId }),
    detail,
  });
}

export function parseAuditEventType(raw: unknown, field = 'audit.type'): AuditEventType {
  if (typeof raw === 'string' && (AUDIT_EVENT_TYPES as readonly string[]).includes(raw)) {
    return raw as AuditEventType;
  }
  throw new DomainError(
    'invalid-audit-event',
    field,
    `audit type must be one of: ${AUDIT_EVENT_TYPES.join(', ')}`,
  );
}

export function parseAuditActor(raw: unknown, field = 'audit.actor'): AuditActor {
  if (typeof raw === 'string' && (AUDIT_ACTORS as readonly string[]).includes(raw)) {
    return raw as AuditActor;
  }
  throw new DomainError(
    'invalid-audit-event',
    field,
    `audit actor must be one of: ${AUDIT_ACTORS.join(', ')}`,
  );
}

export function parseAuditSeverity(raw: unknown, field = 'audit.severity'): AuditSeverity {
  if (typeof raw === 'string' && (AUDIT_SEVERITIES as readonly string[]).includes(raw)) {
    return raw as AuditSeverity;
  }
  throw new DomainError(
    'invalid-audit-event',
    field,
    `audit severity must be one of: ${AUDIT_SEVERITIES.join(', ')}`,
  );
}

function validateDetail(raw: unknown): AuditDetail {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DomainError('invalid-audit-event', 'audit.detail', 'detail must be a plain object');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_DETAIL_KEYS) {
    throw new DomainError(
      'invalid-audit-event',
      'audit.detail',
      `detail accepts at most ${MAX_DETAIL_KEYS} keys`,
    );
  }
  const out: Record<string, AuditDetailValue> = {};
  for (const [key, value] of entries) {
    if (!DETAIL_KEY_PATTERN.test(key)) {
      throw new DomainError(
        'invalid-audit-event',
        'audit.detail',
        'detail keys must match [a-z][a-z0-9._-]{0,47}',
      );
    }
    if (typeof value === 'string') {
      if (
        value.length > MAX_STRING_VALUE ||
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
      ) {
        throw new DomainError(
          'invalid-audit-event',
          'audit.detail',
          `string values must be <= ${MAX_STRING_VALUE} printable chars, already redacted`,
        );
      }
      out[key] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new DomainError('invalid-audit-event', 'audit.detail', 'numbers must be finite');
      }
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else {
      throw new DomainError(
        'invalid-audit-event',
        'audit.detail',
        'values must be string/number/boolean (objects rejected)',
      );
    }
  }
  return Object.freeze(out);
}
