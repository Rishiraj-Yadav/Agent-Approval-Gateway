import { computeMac } from '@raag/security';
import { PROTOCOL_VERSION, parseMessage, type InboundMessage } from './messages.js';

/**
 * The LOCAL authenticated envelope + response frames (ADR-034). A frame is
 * one NDJSON line carrying a LocalEnvelope whose `mac` is an HMAC-SHA256 hex
 * digest (computed with @raag/security) over localMacCanonical(ts,nonce,
 * canonicalMessage). The canonical message text is computed HERE, so the MAC
 * basis is identical on both ends and cannot drift through re-serialization.
 */
export const MAX_LOCAL_FRAME_BYTES = 262_144;
export const NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
const MAC_PATTERN = /^[a-f0-9]{64}$/;
const TS_MAX = 8_640_000_000_000_000; // same bound domain enforces

/** Envelope parse result (message stays opaque; verification is server-side). */
export interface LocalEnvelope {
  readonly ts: number;
  readonly nonce: string;
  readonly mac: string;
  /** canonicalized full MAC-basis string (`raag.local|ts|nonce|message`) */
  readonly canonical: string;
  /** the structurally-validated inner message */
  readonly message: InboundMessage;
}

export type LocalParseResult =
  | { readonly ok: true; readonly envelope: LocalEnvelope }
  | { readonly ok: false; readonly reason: string };

/** Deterministic JSON: object keys sorted lexicographically, no whitespace. */
export function canonicalizeJson(value: unknown): string {
  return stringifyStable(value, 0);
}

const MAX_CANON_DEPTH = 32;

function stringifyStable(value: unknown, depth: number): string {
  if (depth > MAX_CANON_DEPTH) throw new Error('canonicalize depth limit');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('non-finite number in canonical form');
      return String(value);
    case 'boolean':
      return String(value);
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null';
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v, i) => (i < 0 ? '' : stringifyStable(v, depth + 1))).join(',')}]`;
  }
  if (value instanceof Uint8Array) {
    return JSON.stringify(`${value.length}`);
  }
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort();
    const parts = keys
      .filter((k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype')
      .map((k) => `${JSON.stringify(k)}:${stringifyStable(record[k], depth + 1)}`);
    return `{${parts.join(',')}}`;
  }
  return 'null';
}

/** MAC basis string — signed by the local client, verified by the server. */
export function localMacCanonical(ts: number, nonce: string, canonicalMessage: string): string {
  if (!Number.isInteger(ts) || ts <= 0 || ts > TS_MAX) return '\u0000rejected-ts';
  return `raag.local|${ts}|${nonce}|${canonicalMessage}`;
}

export function parseLocalEnvelope(jsonLine: string): LocalParseResult {
  const fail = (reason: string): LocalParseResult => ({ ok: false, reason });
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonLine);
  } catch {
    return fail('invalid-json');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('not-an-object');
  }
  const env = parsed as Record<string, unknown>;
  const keys = Object.keys(env);
  const expected = ['v', 'ts', 'nonce', 'mac', 'message'];
  if (keys.length !== expected.length || !expected.every((k) => keys.includes(k))) {
    return fail('exact-field-set-violation');
  }
  if (env['v'] !== PROTOCOL_VERSION) return fail('bad-version');
  const ts = env['ts'];
  if (typeof ts !== 'number' || !Number.isInteger(ts) || ts <= 0 || ts > TS_MAX) {
    return fail('bad-timestamp');
  }
  const nonce = env['nonce'];
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return fail('bad-nonce');
  const mac = env['mac'];
  if (typeof mac !== 'string' || !MAC_PATTERN.test(mac)) return fail('bad-mac');
  const message = env['message'];
  if (message === null || typeof message !== 'object') return fail('bad-message');
  const body = parseMessage(message); // full structural validation of the inner message
  if (!body.ok) return fail(`bad-message:${body.reason}`);
  let canonical: string;
  try {
    canonical = canonicalizeJson(message);
  } catch {
    return fail('unserializable-message');
  }
  return {
    ok: true,
    envelope: {
      ts,
      nonce,
      mac,
      canonical: localMacCanonical(ts, nonce, canonical),
      message: body.message,
    },
  };
}

/** Build + sign an outbound (client-side) envelope for a message body. */
export function buildLocalEnvelope(
  key: string,
  message: InboundMessage,
  ts: number,
  nonce: string,
): string {
  const canonical = localMacCanonical(ts, nonce, canonicalizeJson(message));
  const mac = computeMac(key, canonical);
  return JSON.stringify({ v: PROTOCOL_VERSION, ts, nonce, mac, message });
}

/** The gateway response frame kinds (ADR-034). */
export interface AckFrame {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: 'ack';
  readonly requestId: string;
  readonly correlationId: string;
  readonly state: string;
  readonly revision: number;
  readonly expiresAtMs: number;
  readonly decisionKind?: string | undefined;
  readonly failureCode?: string | undefined;
}

export interface StatusFrame {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: 'status';
  readonly requestId: string;
  readonly state: string;
  readonly revision: number;
  readonly expiresAtMs: number;
}

export interface ErrorFrame {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: 'error';
  /** stable code only — never echoes raw data (security.md §5) */
  readonly reasonCode:
    | 'frame-too-large'
    | 'parse-failed'
    | 'auth-failed'
    | 'replayed'
    | 'stale-timestamp'
    | 'future-timestamp'
    | 'invalid-message'
    | 'unknown-request'
    | 'capacity'
    | 'shutdown'
    | 'internal';
}

export type ResponseFrame = AckFrame | StatusFrame | ErrorFrame;

/** Server → client frames are NOT MAC'd (§18: trust-boundary is inbound). */
export function serializeResponse(frame: ResponseFrame): string {
  return JSON.stringify(frame) + '\n';
}

export function ackFor(request: {
  readonly requestId: string;
  readonly correlationId: string;
  readonly state: string;
  readonly version: number;
  readonly expiresAt: number;
  readonly decision?: { readonly kind: string };
  readonly failureCode?: string;
}): AckFrame {
  return {
    v: PROTOCOL_VERSION,
    kind: 'ack',
    requestId: request.requestId,
    correlationId: request.correlationId,
    state: request.state,
    revision: request.version,
    expiresAtMs: request.expiresAt,
    ...(request.decision === undefined ? {} : { decisionKind: request.decision.kind }),
    ...(request.failureCode === undefined ? {} : { failureCode: request.failureCode }),
  };
}
