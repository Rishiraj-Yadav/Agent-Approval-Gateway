/**
 * Approval decisions.
 *
 * The specification distinguishes four decision kinds with different scopes;
 * modeling them as a boolean would lose exactly the information operators
 * need. Note what each kind MEANS:
 *
 * - allow-once    : permit this single action; no durable effect.
 * - allow-session : permit matching actions for THIS session only. The
 *                   domain records the intent; whether/where the agent
 *                   enforces the session scope is adapter + policy work
 *                   (later phases). It never widens native permissions.
 * - deny          : refuse this action.
 * - stop-agent    : refuse this action AND signal the agent process to halt.
 *                   Phase 2 only represents the intent — nothing is executed.
 *
 * Terminal-state mapping is centralized (`terminalStateForDecision`) so
 * `deny`/`stop-agent` can never be reinterpreted as an approval later.
 */
import { DomainError } from './errors.js';
import type { Millis } from './time.js';

export const DECISION_KINDS = ['allow-once', 'allow-session', 'deny', 'stop-agent'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const APPROVED_STATES = ['approved'] as const;
export type TerminalResolution = 'approved' | 'denied';

export function parseDecisionKind(raw: unknown, field = 'decision'): DecisionKind {
  if (typeof raw === 'string' && (DECISION_KINDS as readonly string[]).includes(raw)) {
    return raw as DecisionKind;
  }
  throw new DomainError(
    'invalid-decision',
    field,
    `decision must be one of: ${DECISION_KINDS.join(', ')}`,
  );
}

/** The state-machine target of a decision (allow variants approve; deny/stop deny). */
export function terminalStateForDecision(kind: DecisionKind): TerminalResolution {
  return kind === 'allow-once' || kind === 'allow-session' ? 'approved' : 'denied';
}

/** True only for decisions whose effect on the current action is permission. */
export function decisionAllows(kind: DecisionKind): boolean {
  return terminalStateForDecision(kind) === 'approved';
}

/** Decisions whose semantics extend beyond the single action. */
export function decisionHasSessionScope(kind: DecisionKind): boolean {
  return kind === 'allow-session';
}

export function decisionRequestsStop(kind: DecisionKind): boolean {
  return kind === 'stop-agent';
}

/** A persisted decision record, stamped with the core-observed decision time. */
export interface DecisionRecord {
  readonly kind: DecisionKind;
  /** Core-clock instant the decision was accepted (never client-provided). */
  readonly decidedAt: Millis;
}
