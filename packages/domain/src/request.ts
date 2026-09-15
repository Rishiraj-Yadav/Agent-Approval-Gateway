/**
 * The ApprovalRequest aggregate root.
 *
 * Correlation model (spec §4): every request carries BOTH a `requestId`
 * (this approval's identity) and a `correlationId` (the upstream agent-side
 * call identity the decision must be routed back against), plus the scope
 * triple machine/project/session that fixes where it came from. All scopes
 * are immutable after creation; the state machine changes only `state`,
 * `version`, and the optional `decision`/`failureCode` fields.
 *
 * Requests are FROZEN at creation; every transition produces a new object
 * with a bumped `version` (revision token for optimistic concurrency,
 * architecture.md §18).
 */
import type { ActionDescriptor } from './action.js';
import { createActionDescriptor } from './action.js';
import type { DecisionRecord } from './decision.js';
import { DomainError } from './errors.js';
import { parseCorrelationId, parseRequestId, type CorrelationId, type RequestId } from './ids.js';
import type { FailureCode } from './machine.js';
import { parseFailureCode } from './machine.js';
import {
  createMachineIdentity,
  createProjectDescriptor,
  createSessionContext,
  createAgentIdentity,
} from './identity.js';
import type {
  MachineIdentity,
  ProjectDescriptor,
  SessionContext,
  AgentIdentity,
} from './identity.js';
import { parseRiskLevel, type RiskLevel } from './risk.js';
import type { ApprovalState } from './states.js';
import {
  DEFAULT_APPROVAL_TTL_SECONDS,
  parseMillis,
  secondsToDuration,
  addDuration,
  type Millis,
  type DurationMillis,
} from './time.js';

const DEFAULT_TTL_FALLBACK_SECONDS = DEFAULT_APPROVAL_TTL_SECONDS;

export interface ApprovalRequest {
  readonly requestId: RequestId;
  readonly correlationId: CorrelationId;
  readonly agent: AgentIdentity;
  readonly machine: MachineIdentity;
  readonly project: ProjectDescriptor;
  readonly session: SessionContext;
  readonly action: ActionDescriptor;
  readonly risk: RiskLevel;
  /** Core-clock creation instant. */
  readonly requestedAt: Millis;
  /** Inclusive expiry instant (ADR-019: expired at `now >= expiresAt`). */
  readonly expiresAt: Millis;
  readonly state: ApprovalState;
  /** Optimistic-concurrency revision; bumps on every advanced transition. */
  readonly version: number;
  /** Present iff a human/policy decision recorded the resolution. */
  readonly decision?: DecisionRecord;
  /** Present iff state === "failed". */
  readonly failureCode?: FailureCode;
}

export interface NewRequestInput {
  readonly requestId: unknown;
  readonly correlationId: unknown;
  readonly agent: unknown;
  readonly machine: unknown;
  readonly project: unknown;
  readonly session: unknown;
  readonly action: unknown;
  readonly risk: unknown;
  /** Core-clock instant, not caller clock once past this boundary. */
  readonly requestedAt: unknown;
  /** TTL in whole seconds; omitted = DEFAULT_APPROVAL_TTL_SECONDS. */
  readonly ttlSeconds?: unknown;
}

export function createApprovalRequest(input: NewRequestInput): ApprovalRequest {
  const requestId = parseRequestId(input.requestId);
  const correlationId = parseCorrelationId(input.correlationId);

  const agent = createAgentIdentity(need(input.agent, 'agent'));
  const machine = createMachineIdentity(need(input.machine, 'machine'));
  const project = createProjectDescriptor(need(input.project, 'project'));
  const session = createSessionContext(need(input.session, 'session'));
  const action = createActionDescriptor(need(input.action, 'action'));
  const risk = parseRiskLevel(input.risk);
  const requestedAt = parseMillis(input.requestedAt, 'requestedAt');

  const ttl: DurationMillis =
    input.ttlSeconds === undefined
      ? secondsToDuration(DEFAULT_TTL_FALLBACK_SECONDS)
      : ttlSecondsToDuration(input.ttlSeconds);

  const expiresAt = addDuration(requestedAt, ttl);

  const request: ApprovalRequest = Object.freeze({
    requestId,
    correlationId,
    agent,
    machine,
    project,
    session,
    action,
    risk,
    requestedAt,
    expiresAt,
    state: 'created' as const,
    version: 1,
  });
  return request;
}

/** Revalidate a request hydrated from storage (repository boundary). */
export function reviveApprovalRequest(
  candidate: ApprovalRequest,
  now: Millis | undefined,
): ApprovalRequest {
  const checked = createApprovalRequestFromExisting(candidate);
  assertStateShape(checked, now);
  return checked;
}

/** Impossible state/decision/failure combinations cannot survive revival. */
function assertStateShape(req: ApprovalRequest, now: Millis | undefined): void {
  if (!Number.isInteger(req.version) || req.version < 1) {
    throw new DomainError('invalid-request', 'version', 'revision must be a positive integer');
  }
  const hasDecision = req.decision !== undefined;
  const hasFailure = req.failureCode !== undefined;
  switch (req.state) {
    case 'approved':
    case 'denied':
      if (!hasDecision || hasFailure) {
        throw new DomainError(
          'invalid-request',
          'state',
          'approved/denied require a decision and no failure code',
        );
      }
      break;
    case 'failed':
      if (!hasFailure || hasDecision) {
        throw new DomainError(
          'invalid-request',
          'state',
          'failed requires a failure code and no decision',
        );
      }
      parseFailureCode(req.failureCode, 'failureCode');
      break;
    case 'created':
    case 'pending':
    case 'expired':
    case 'cancelled':
    case 'agent-disconnected':
      if (hasDecision || hasFailure) {
        throw new DomainError(
          'invalid-request',
          'state',
          'this state can carry neither a decision nor a failure code',
        );
      }
      break;
  }
  if (req.state === 'created' || req.state === 'pending') {
    if (now === undefined) {
      throw new DomainError(
        'invalid-request',
        'now',
        'revalidating a live request requires the core clock instant',
      );
    }
  }
}

function createApprovalRequestFromExisting(existing: ApprovalRequest): ApprovalRequest {
  const base = createApprovalRequest({
    requestId: existing.requestId,
    correlationId: existing.correlationId,
    agent: { kind: existing.agent.kind, version: existing.agent.version },
    machine: { id: existing.machine.id, displayName: existing.machine.displayName },
    project: { id: existing.project.id, displayPath: existing.project.displayPath },
    session: { sessionId: existing.session.sessionId },
    action: {
      tool: existing.action.tool,
      displaySummary: existing.action.displaySummary,
      payloadSha256: existing.action.payloadSha256,
      payloadBytes: existing.action.payloadBytes,
    },
    risk: existing.risk,
    requestedAt: existing.requestedAt,
    ttlSeconds: secondsOf(existing),
  });
  return Object.freeze({
    ...base,
    state: existing.state,
    version: existing.version,
    ...(existing.decision === undefined ? {} : { decision: existing.decision }),
    ...(existing.failureCode === undefined ? {} : { failureCode: existing.failureCode }),
  });
}

function secondsOf(existing: ApprovalRequest): number {
  const span = existing.expiresAt - existing.requestedAt;
  if (span % 1000 !== 0 || span <= 0) {
    throw new DomainError(
      'invalid-request',
      'expiresAt',
      'expiration must be a whole number of seconds after creation',
    );
  }
  return span / 1000;
}

function ttlSecondsToDuration(raw: unknown): DurationMillis {
  if (typeof raw !== 'number') {
    throw new DomainError('invalid-duration', 'ttlSeconds', 'ttl must be a number of seconds');
  }
  return secondsToDuration(raw);
}

function need<T>(value: unknown, field: string): T {
  if (value === null || typeof value !== 'object') {
    throw new DomainError('invalid-request', field, `${field} must be an object`);
  }
  return value as T;
}
