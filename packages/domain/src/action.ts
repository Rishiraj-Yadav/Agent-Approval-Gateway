/**
 * The action a request seeks permission for.
 *
 * CRITICAL trust model: `tool` and `payloadSha256` are structural;
 * `displaySummary` is UNTRUSTED, already-redacted, presentation-only text —
 * nothing may ever pattern-match or decide on it (prompt-injection through
 * summaries is expected, security.md §3). Raw payloads are never held here;
 * the SHA-256 (lowercase hex) is the only content reference.
 */
import { DomainError } from './errors.js';

const TOOL_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
export const MAX_ACTION_SUMMARY_LEN = 2040;

export interface ActionDescriptor {
  /** Tool identifier as reported by the adapter (e.g. "bash", "edit_file"). */
  readonly tool: string;
  /** Redacted human summary from the adapter's redaction step. DISPLAY ONLY. */
  readonly displaySummary: string;
  /** SHA-256 hex of the raw (discarded) payload. Content identity. */
  readonly payloadSha256: string;
  /** Byte length of the raw payload, for operator context. */
  readonly payloadBytes: number;
}

export function createActionDescriptor(raw: {
  readonly tool: unknown;
  readonly displaySummary: unknown;
  readonly payloadSha256: unknown;
  readonly payloadBytes: unknown;
}): ActionDescriptor {
  if (typeof raw.tool !== 'string' || !TOOL_PATTERN.test(raw.tool)) {
    throw new DomainError(
      'invalid-action',
      'action.tool',
      'tool must be 1-64 chars matching [A-Za-z][A-Za-z0-9_.:-]*',
    );
  }
  if (typeof raw.payloadSha256 !== 'string' || !SHA256_HEX_PATTERN.test(raw.payloadSha256)) {
    throw new DomainError(
      'invalid-action',
      'action.payloadSha256',
      'must be 64 lowercase hex chars',
    );
  }
  if (
    typeof raw.payloadBytes !== 'number' ||
    !Number.isInteger(raw.payloadBytes) ||
    raw.payloadBytes < 0
  ) {
    throw new DomainError(
      'invalid-action',
      'action.payloadBytes',
      'must be a non-negative integer',
    );
  }
  if (
    typeof raw.displaySummary !== 'string' ||
    raw.displaySummary.length === 0 ||
    raw.displaySummary.length > MAX_ACTION_SUMMARY_LEN ||
    // eslint-disable-next-line no-control-regex -- control chars in a DISPLAY field are hostile
    raw.displaySummary.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/)
  ) {
    throw new DomainError(
      'invalid-action',
      'action.displaySummary',
      `display summary must be 1-${MAX_ACTION_SUMMARY_LEN} chars, printable (already redacted by the adapter)`,
    );
  }
  return Object.freeze({
    tool: raw.tool,
    displaySummary: raw.displaySummary,
    payloadSha256: raw.payloadSha256,
    payloadBytes: raw.payloadBytes,
  });
}
