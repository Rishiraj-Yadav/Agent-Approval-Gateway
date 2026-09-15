import {
  millisOf,
  parseDecisionKind,
  reviveApprovalRequest,
  type ApprovalRequest,
  type AuditEvent,
  type Millis,
} from '@raag/domain';

/**
 * Row codec. Every decoded field is re-validated through the domain's own
 * constructors (fail closed): a manually-tampered or corrupt row hydrates to
 * a thrown error, never to a trusted request.
 */

export interface RequestRow {
  request_id: string;
  correlation_id: string;
  agent_kind: string;
  agent_version: string;
  machine_id: string;
  machine_display: string;
  project_id: string;
  project_display: string;
  session_id: string;
  tool: string;
  display_summary: string;
  payload_sha256: string;
  payload_bytes: number | bigint;
  risk: string;
  state: string;
  requested_at: number | bigint;
  expires_at: number | bigint;
  revision: number | bigint;
  decision_kind: string | null;
  decided_at: number | bigint | null;
  failure_code: string | null;
}

/** node:sqlite returns wide INTEGERs as bigint when unsafe; both are accepted. */
function asNumber(raw: number | bigint): number {
  return typeof raw === 'bigint' ? Number(raw) : raw;
}

export function rowToRequest(row: RequestRow, now: Millis): ApprovalRequest {
  if (row.decision_kind !== null && row.decided_at === null) {
    throw new Error('corrupt row: decision_kind without decided_at');
  }
  const decision =
    row.decision_kind === null || row.decided_at === null
      ? undefined
      : {
          kind: parseDecisionKind(row.decision_kind, 'row.decision_kind'),
          decidedAt: millisOf(asNumber(row.decided_at)),
        };
  const candidate = {
    requestId: row.request_id,
    correlationId: row.correlation_id,
    agent: {
      kind: row.agent_kind,
      version: row.agent_version,
    },
    machine: { id: row.machine_id, displayName: row.machine_display },
    project: { id: row.project_id, displayPath: row.project_display },
    session: { sessionId: row.session_id },
    action: {
      tool: row.tool,
      displaySummary: row.display_summary,
      payloadSha256: row.payload_sha256,
      payloadBytes: asNumber(row.payload_bytes),
    },
    risk: row.risk,
    requestedAt: asNumber(row.requested_at),
    expiresAt: asNumber(row.expires_at),
    state: row.state,
    version: asNumber(row.revision),
    ...(decision === undefined ? {} : { decision }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
  } as unknown as ApprovalRequest;
  return reviveApprovalRequest(candidate, now);
}

const REQUEST_INSERT_COLUMNS = [
  'request_id',
  'correlation_id',
  'agent_kind',
  'agent_version',
  'machine_id',
  'machine_display',
  'project_id',
  'project_display',
  'session_id',
  'tool',
  'display_summary',
  'payload_sha256',
  'payload_bytes',
  'risk',
  'state',
  'requested_at',
  'expires_at',
  'revision',
  'decision_kind',
  'decided_at',
  'failure_code',
] as const;

/** Immutable-after-insert fields (CAS must pin them; see store SQL). */
export const IMMUTABLE_ROW_FIELDS = [
  'correlation_id',
  'agent_kind',
  'agent_version',
  'machine_id',
  'machine_display',
  'project_id',
  'project_display',
  'session_id',
  'tool',
  'display_summary',
  'payload_sha256',
  'payload_bytes',
  'risk',
  'requested_at',
  'expires_at',
] as const;

export const requestColumns = {
  insertList: REQUEST_INSERT_COLUMNS.join(', '),
  insertPlaceholders: REQUEST_INSERT_COLUMNS.map((c) => `:${c}`).join(', '),
};

export function requestInsertParams(
  request: ApprovalRequest,
): Record<string, string | number | null> {
  return {
    request_id: request.requestId,
    correlation_id: request.correlationId,
    agent_kind: request.agent.kind,
    agent_version: request.agent.version,
    machine_id: request.machine.id,
    machine_display: request.machine.displayName,
    project_id: request.project.id,
    project_display: request.project.displayPath,
    session_id: request.session.sessionId,
    tool: request.action.tool,
    display_summary: request.action.displaySummary,
    payload_sha256: request.action.payloadSha256,
    payload_bytes: request.action.payloadBytes,
    risk: request.risk,
    state: request.state,
    requested_at: request.requestedAt,
    expires_at: request.expiresAt,
    revision: request.version,
    decision_kind: request.decision ? request.decision.kind : null,
    decided_at: request.decision ? request.decision.decidedAt : null,
    failure_code: request.failureCode ?? null,
  };
}

/* audit codec */

export interface AuditRow {
  seq: number | bigint;
  occurred_at: number | bigint;
  type: string;
  actor: string;
  severity: string;
  request_id: string | null;
  correlation_id: string | null;
  detail_json: string;
}

/** Deterministic JSON: sorted keys so rows are byte-stable for tests. */
export function canonicalDetailJson(
  detail: Readonly<Record<string, string | number | boolean>>,
): string {
  const entries = Object.entries(detail).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

const MAX_DETAIL_JSON_BYTES = 4096;

export function encodeAuditEvent(event: AuditEvent): {
  params: Record<string, string | number | null>;
} {
  const detailJson = event.detail ? canonicalDetailJson(event.detail) : '[]';
  if (detailJson.length > MAX_DETAIL_JSON_BYTES) {
    throw new Error('detail exceeds storage cap');
  }
  return {
    params: {
      occurred_at: event.occurredAt,
      type: event.type,
      actor: event.actor,
      severity: event.severity,
      request_id: event.requestId ?? null,
      correlation_id: event.correlationId ?? null,
      detail_json: detailJson,
    },
  };
}

export function decodeAuditRow(row: AuditRow): Record<string, unknown> {
  return {
    seq: asNumber(row.seq),
    occurredAt: row.occurred_at,
    type: row.type,
    actor: row.actor,
    severity: row.severity,
    requestId: row.request_id,
    correlationId: row.correlation_id,
    detailJson: row.detail_json,
  };
}
