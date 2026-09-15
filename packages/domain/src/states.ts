/**
 * The approval lifecycle states (Phase 2 spec; reconciliation with the older
 * names in docs/architecture.md §14 is recorded in ADR-019).
 *
 *   created             — validated + durable insert, prompt not yet sent
 *   pending             — awaiting a human/policy outcome
 *   approved / denied   — terminal decisions
 *   expired             — terminal, deny-equivalent (TTL elapsed)
 *   cancelled           — terminal, deny-equivalent (agent/operator withdrew)
 *   agent-disconnected  — terminal, deny-equivalent (origin is gone; nothing
 *                         can be delivered, so the request dies closed)
 *   failed              — terminal, deny-equivalent infrastructure fault
 *                         (e.g. persistence/audit error made continuation
 *                          unsafe — see security.md §3)
 *
 * Terminal means FINAL: no terminal state ever transitions back to created/
 * pending, and approved never becomes anything. `expired`, `cancelled`,
 * `agent-disconnected` and `failed` are deny-equivalent in their delivery to
 * in their delivery to the agent (done at the application layer, later
 * phases).
 */
import { DomainError } from './errors.js';

export const APPROVAL_STATES = [
  'created',
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
  'agent-disconnected',
  'failed',
] as const;
export type ApprovalState = (typeof APPROVAL_STATES)[number];

export const TERMINAL_STATES: readonly ApprovalState[] = [
  'approved',
  'denied',
  'expired',
  'cancelled',
  'agent-disconnected',
  'failed',
];

export const LIVE_STATES: readonly ApprovalState[] = ['created', 'pending'];

export function isTerminalState(state: ApprovalState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function parseApprovalState(raw: unknown, field = 'state'): ApprovalState {
  if (typeof raw === 'string' && (APPROVAL_STATES as readonly string[]).includes(raw)) {
    return raw as ApprovalState;
  }
  throw new DomainError(
    'invalid-state',
    field,
    `state must be one of: ${APPROVAL_STATES.join(', ')}`,
  );
}
