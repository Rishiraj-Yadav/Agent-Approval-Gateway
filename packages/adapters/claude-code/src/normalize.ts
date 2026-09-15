/// <reference types="node" />
import { createHash } from 'node:crypto';
import { redactString } from '@raag/security';
import { createApprovalRequest, type ApprovalRequest, type AgentKind } from '@raag/domain';

/**
 * @raag/claude-code — Claude Code agent adapter. **SKELETON ONLY.**
 *
 * WHAT THIS IS: the normalization boundary — it translates a parsed
 * `PreToolUse`-style hook payload (JSON arriving on stdin FROM Claude Code,
 * per Claude Code's documented hooks surface) into a validated domain
 * ApprovalRequest, and maps terminal decisions back to the hook's expected
 * stdout response shape.
 *
 * WHAT THIS IS *NOT* (later-phase work, not implemented here):
 *  - no hook wiring/settings writing, no process I/O, NO EXECUTION of any
 *    agent command (ADR-004), no native Claude security bypass, no terminal
 *    scraping, no keyboard simulation, no network calls — verified by tests.
 *  - NOT INTEGRATION-TESTED against a running Claude Code CLI. This module's
 *    input contract is the normalization shape *we* define around documented
 *    hook fields; the real CLI schema is validated in Phase 3 when a
 *    fixture-driven recording (tests/fixtures) replaces these hand-written
 *    samples.
 *
 * Trust: `tool_input` is UNTRUSTED. Only a size-capped SHA-256 digest and a
 * redacted display summary survive into the ApprovalRequest; raw payloads
 * are never held, logged, or forwarded.
 */
export const packageName = '@raag/claude-code' as const;
export const AGENT_KIND: AgentKind = 'claude-code';

/**
 * Hook payload shape as we normalize it (subset of Claude Code PreToolUse:
 * session_id, transcript_path, cwd, hook_event_name, tool_name, tool_input,
 * tool_use_id). Extra fields from a future CLI version are IGNORED (forward
 * compatible), unknown/invalid mandatory fields fail closed.
 */
export interface PreToolUseHookPayload {
  readonly hook_event_name?: unknown;
  readonly session_id?: unknown;
  readonly tool_use_id?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly cwd?: unknown;
  readonly transcript_path?: unknown;
  readonly permission_suggestions?: unknown;
}

interface NormalizeContext {
  readonly machineId: string;
  readonly projectId: string;
}

export type NormalizeResult =
  | { readonly ok: true; readonly request: ApprovalRequest }
  | { readonly ok: false; readonly reason: string };

export function normalizeToApprovalRequest(
  payload: PreToolUseHookPayload,
  ctx: NormalizeContext,
  coreNowMs: number,
): NormalizeResult {
  if (payload.hook_event_name !== 'PreToolUse') {
    return { ok: false, reason: 'unsupported-hook-event' };
  }
  const sessionId = boundedId(payload.session_id);
  const tool = boundedString(payload.tool_name, 64);
  if (sessionId === undefined || tool === undefined) {
    return { ok: false, reason: 'missing-required-fields' };
  }
  const useId =
    typeof payload.tool_use_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(payload.tool_use_id)
      ? payload.tool_use_id
      : 'native';

  // untrusted → bounded digest + redacted display form; nothing else survives
  const raw = JSON.stringify(payload.tool_input ?? null) ?? 'null';
  const hash = createHash('sha256').update(raw).digest('hex');
  const bytes = Buffer.byteLength(raw);
  const displaySummary = redactString(safeSummary(payload.tool_input)).slice(0, 2_000);

  try {
    const request = createApprovalRequest({
      requestId: 'req-' + useId,
      correlationId: useId,
      agent: { kind: AGENT_KIND, version: 'unknown' },
      machine: { id: ctx.machineId },
      project: {
        id: ctx.projectId,
        displayPath: typeof payload.cwd === 'string' ? payload.cwd.slice(0, 512) : undefined,
      },
      session: { sessionId },
      action: {
        tool,
        displaySummary: displaySummary || `${tool} (no display summary)`,
        payloadSha256: hash,
        payloadBytes: bytes,
      },
      risk: 'medium', // SKELETON: default-neutral; risk classification is policy-phase work
      requestedAt: coreNowMs,
    });
    return { ok: true, request };
  } catch (error) {
    // domain errors are code+field only (never echo input)
    return { ok: false, reason: `domain-rejected:${(error as Error).message.slice(0, 200)}` };
  }
}

/**
 * Maps a terminal decision to what a PreToolUse hook should have answered.
 * The *string produced* is inert data here; only a real hook integration
 * (later phase) writes it to stdout within a Claude Code process.
 */
export function renderHookDecision(request: ApprovalRequest): 'allow' | 'deny' | 'ask' {
  switch (request.state) {
    case 'approved':
      return 'allow';
    case 'denied':
    case 'expired':
    case 'cancelled':
    case 'agent-disconnected':
    case 'failed':
      return 'deny';
    case 'created':
    case 'pending':
      // no final decision (still open / disconnected mid-flight): the native
      // prompt remains authoritative — do not answer as if decided.
      return 'ask';
  }
}

function boundedString(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > max) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return undefined;
  return raw;
}

/** Same opaque-ID contract the domain enforces, checked pre-construction. */
function boundedId(raw: unknown, max = 128): string | undefined {
  const s = boundedString(raw, max);
  if (s === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s)) return undefined;
  return s;
}

function safeSummary(input: unknown): string {
  if (input === null || input === undefined) return '(no input reported)';
  if (typeof input === 'string') return input.slice(0, 400);
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  if (typeof input === 'bigint') return input.toString();
  const rec = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(rec).slice(0, 8)) {
    const v = rec[key];
    parts.push(`${key}=${JSON.stringify(v) ?? '[?]'}`);
  }
  return `tool_input{${parts.join(', ')}}`.slice(0, 2_000);
}
