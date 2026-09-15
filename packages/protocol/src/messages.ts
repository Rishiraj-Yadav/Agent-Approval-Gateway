import { redactString } from '@raag/security';

/**
 * @raag/protocol — normalized wire DTOs for gateway↔adapter (loopback) and
 * gateway↔relay traffic. NO transport code lives here (no HTTP/WS/Telegram).
 *
 * UNTRUSTED BY DEFINITION: every message arriving from a socket or stdin is
 * `unknown` until `parseMessage` returns it. Parsing is strict (exact field
 * sets, opaque-ID shape, byte caps) and rejects — never coerces. The opaque
 * callback token is carried as an opaque string: the protocol never defines
 * a way to embed executable content in identifiers, and the display summary
 * is re-redacted defensively because producers are adapters on other boxes.
 *
 * Correlation: `correlationId` survives submit→decide verbatim so the
 * application layer can join responses to originating agent requests.
 */
export const packageName = '@raag/protocol' as const;

export const PROTOCOL_VERSION = 'raag.v1' as const;
const MAX_BODY_BYTES = 262_144; // 256 KB (architecture.md §9)
const MAX_SUMMARY_CHARS = 2_040;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type AgentKindWire = 'claude-code' | 'codex' | 'kilo' | (string & {});

export interface SubmitMessage {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: 'submit';
  readonly requestId: string;
  readonly correlationId: string;
  readonly machineId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly agent: { readonly kind: AgentKindWire; readonly version: string };
  readonly action: {
    readonly tool: string;
    readonly displaySummary: string; // re-redacted on parse; display-only
    readonly payloadSha256: string;
    readonly payloadBytes: number;
  };
  readonly risk: 'low' | 'medium' | 'high' | 'critical';
  readonly requestedAtMs: number;
  readonly ttlSeconds: number;
}

export interface DecisionMessage {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: 'decision';
  /** Opaque — a channel callback token. NEVER parsed/executed. */
  readonly requestId: string;
  readonly correlationId: string;
  /** ADR-034: every frame asserts the scope it acts on (server re-checks). */
  readonly machineId: string;
  readonly decision: 'allow-once' | 'allow-session' | 'deny' | 'stop-agent';
  readonly token: string;
}

export interface RejectMessage {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: 'reject';
  readonly requestId: string;
  readonly reasonCode: string; // stable code; never free-form hostile text
}

/** Gateway-local lifecycle probes/commands (authenticated by envelope MAC). */
export interface RequestScopeMessage {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: 'status' | 'cancel' | 'agent-disconnected';
  readonly requestId: string;
  readonly correlationId: string;
  readonly machineId: string;
}

export type OutboundMessage = SubmitMessage | DecisionMessage | RejectMessage;
export type InboundMessage = SubmitMessage | DecisionMessage | RejectMessage | RequestScopeMessage;

export type ParseResult =
  | { readonly ok: true; readonly message: InboundMessage }
  | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'string' || value === null || typeof value !== 'object'
    ? false
    : !Array.isArray(value);
}

function id(raw: unknown): string | undefined {
  return typeof raw === 'string' && OPAQUE_ID.test(raw) ? raw : undefined;
}

function str(raw: unknown, max = 128): string | undefined {
  return typeof raw === 'string' &&
    raw.length > 0 &&
    raw.length <= max &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(raw)
    ? raw
    : undefined;
}

function finite(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

const EXACT: Record<InboundMessage['kind'], readonly string[]> = {
  submit: [
    'v',
    'kind',
    'requestId',
    'correlationId',
    'machineId',
    'projectId',
    'sessionId',
    'agent',
    'action',
    'risk',
    'requestedAtMs',
    'ttlSeconds',
  ],
  decision: ['v', 'kind', 'requestId', 'correlationId', 'machineId', 'decision', 'token'],
  reject: ['v', 'kind', 'requestId', 'reasonCode'],
  status: ['v', 'kind', 'requestId', 'correlationId', 'machineId'],
  cancel: ['v', 'kind', 'requestId', 'correlationId', 'machineId'],
  'agent-disconnected': ['v', 'kind', 'requestId', 'correlationId', 'machineId'],
};

function hasExactKeys(obj: Record<string, unknown>, list: readonly string[]): boolean {
  const keys = Object.keys(obj);
  return (
    keys.length === list.length &&
    keys.every((k) => list.includes(k)) &&
    list.every((k) => keys.includes(k))
  );
}

/**
 * Strict parse of raw wire data. Rejects: wrong version, unknown kinds,
 * extra/missing fields, non-opaque ids, hostile control chars, oversized
 * summaries (length-gated before any regex work), and unknown risks.
 */
export function parseMessage(input: unknown): ParseResult {
  const reject = (reason: string): ParseResult => ({ ok: false, reason });
  if (!isRecord(input)) return reject('not-an-object');
  if (input['v'] !== PROTOCOL_VERSION) return reject('bad-version');
  const kind = input['kind'];
  const validKinds = ['submit', 'decision', 'reject', 'status', 'cancel', 'agent-disconnected'];
  if (typeof kind !== 'string' || !validKinds.includes(kind)) return reject('bad-kind');
  const narrowed = kind as InboundMessage['kind'];
  if (!hasExactKeys(input, EXACT[narrowed])) return reject('exact-field-set-violation');

  const requestId = id(input['requestId']);
  if (requestId === undefined) return reject('bad-identifiers');

  if (narrowed === 'reject') {
    const reasonCode = str(input['reasonCode']);
    if (reasonCode === undefined || !/^[a-z][a-z0-9._-]{1,63}$/.test(reasonCode)) {
      return reject('bad-reason-code');
    }
    return { ok: true, message: { v: PROTOCOL_VERSION, kind: 'reject', requestId, reasonCode } };
  }

  const correlationId = id(input['correlationId']);
  if (correlationId === undefined) return reject('bad-identifiers');

  if (narrowed === 'status' || narrowed === 'cancel' || narrowed === 'agent-disconnected') {
    const machineId = id(input['machineId']);
    if (machineId === undefined) return reject('bad-scope-ids');
    return {
      ok: true,
      message: {
        v: PROTOCOL_VERSION,
        kind: narrowed,
        requestId,
        correlationId,
        machineId,
      },
    };
  }

  if (kind === 'decision') {
    const decision = input['decision'];
    const valid = ['allow-once', 'allow-session', 'deny', 'stop-agent'];
    if (typeof decision !== 'string' || !valid.includes(decision)) return reject('bad-decision');
    const decisionMachineId = id(input['machineId']);
    if (decisionMachineId === undefined) return reject('bad-identifiers');
    const token = input['token'];
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > 256 ||
      // opaque base64url-ish only; anything else fails closed
      !/^[A-Za-z0-9_-]{8,256}={0,2}$/.test(token)
    ) {
      return reject('bad-token');
    }
    return {
      ok: true,
      message: {
        v: PROTOCOL_VERSION,
        kind: 'decision',
        requestId,
        correlationId,
        machineId: decisionMachineId,
        decision: decision as DecisionMessage['decision'],
        token,
      },
    };
  }

  // submit
  const machineId = id(input['machineId']);
  const projectId = id(input['projectId']);
  const sessionId = id(input['sessionId']);
  if (!machineId || !projectId || !sessionId) return reject('bad-scope-ids');

  const agent = isRecord(input['agent']) ? input['agent'] : undefined;
  if (!agent || !hasExactKeys(agent, ['kind', 'version'])) return reject('bad-agent');
  const agentKind = str(agent['kind']);
  const agentVersion = str(agent['version']);
  if (!agentKind || !agentVersion) return reject('bad-agent');

  const action = isRecord(input['action']) ? input['action'] : undefined;
  if (
    !action ||
    !hasExactKeys(action, ['tool', 'displaySummary', 'payloadSha256', 'payloadBytes'])
  ) {
    return reject('bad-action');
  }
  const tool = str(action['tool']);
  const rawSummary =
    typeof action['displaySummary'] === 'string' ? action['displaySummary'] : undefined;
  const sha = str(action['payloadSha256']);
  const bytes = finite(action['payloadBytes']);
  const risk = input['risk'];
  const validRisk = ['low', 'medium', 'high', 'critical'];
  const requestedAtMs = finite(input['requestedAtMs']);
  const ttlSeconds = finite(input['ttlSeconds']);
  if (
    !tool ||
    rawSummary === undefined ||
    rawSummary.length === 0 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(rawSummary) ||
    rawSummary.length > MAX_SUMMARY_CHARS ||
    !sha ||
    !/^[a-f0-9]{64}$/.test(sha) ||
    bytes === undefined ||
    !Number.isInteger(bytes) ||
    bytes < 0 ||
    typeof risk !== 'string' ||
    !validRisk.includes(risk) ||
    requestedAtMs === undefined ||
    !Number.isInteger(requestedAtMs) ||
    requestedAtMs < 0 ||
    ttlSeconds === undefined ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > 3_600
  ) {
    return reject('bad-submit-fields');
  }
  // depth/size guard against exotic nesting bombs in an untrusted object
  if (JSON.stringify(input).length > MAX_BODY_BYTES) return reject('body-too-large');

  return {
    ok: true,
    message: {
      v: PROTOCOL_VERSION,
      kind: 'submit',
      requestId,
      correlationId,
      machineId,
      projectId,
      sessionId,
      agent: { kind: agentKind, version: agentVersion },
      action: {
        tool,
        // defense in depth: another host's adapter may be sloppy
        displaySummary: redactString(rawSummary),
        payloadSha256: sha,
        payloadBytes: bytes,
      },
      risk: risk as SubmitMessage['risk'],
      requestedAtMs,
      ttlSeconds,
    },
  };
}

/** Serializing OUTBOUND (built by our own code): stable envelope, no re-validation needed at the far end beyond parseMessage. */
export function serializeMessage(message: OutboundMessage): string {
  return JSON.stringify(message);
}

/** Builder from trusted domain fields for the loopback/relay submit path. */
export function buildSubmitMessage(message: Omit<SubmitMessage, 'v' | 'kind'>): SubmitMessage {
  return { ...message, v: PROTOCOL_VERSION, kind: 'submit' };
}

export function buildDecisionMessage(
  message: Omit<DecisionMessage, 'v' | 'kind'>,
): DecisionMessage {
  return { ...message, v: PROTOCOL_VERSION, kind: 'decision' };
}

export function buildRejectMessage(message: Omit<RejectMessage, 'v' | 'kind'>): RejectMessage {
  return { ...message, v: PROTOCOL_VERSION, kind: 'reject' };
}
