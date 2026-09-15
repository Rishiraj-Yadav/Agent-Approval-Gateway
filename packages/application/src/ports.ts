import type {
  ApprovalRequest,
  DecisionKind,
  LifecycleEvent,
  PolicyOutcome,
  RequestId,
} from '@raag/domain';

/**
 * Ports implemented by LEAF packages / composition root (placement rule,
 * ADR-003/020): anything that performs I/O or vendor work is an interface
 * defined here in @raag/application and implemented elsewhere.
 *
 * Each port exists for a reason — none are speculative surfaces; if a later
 * phase doesn't need a method, delete it rather than keep placeholders.
 */

/** WHY: submit path must run deny-first local rules BEFORE human prompts. */
export interface PolicyEngine {
  /** Pure evaluation (no rules-store I/O in the signature): load rules above. */
  evaluate(request: ApprovalRequest): PolicyOutcome;
}

/** WHY: notification is the only human-visible step that may fail. */
export interface NotificationProvider {
  /** May be called with the full request; provider must redact at display time. */
  prompt(request: ApprovalRequest): void | Promise<void>;
  /** Update UI after resolution (keyboard removal etc.). Missing prompts ok. */
  retract(requestId: RequestId, outcome: string): void | Promise<void>;
}

/** WHY: human decisions arrive from a future channel (v1 Telegram) and must
 * be validated BEFORE touching the manager — the channel emits only
 * already-authenticated decision events for THIS core. */
export interface ApprovalChannel {
  /**
   * Implementations validate origin auth/idempotency and call onDecision with
   * exactly one of the domain events; channel code owns NO policy over
   * terminal states.
   */
  onDecision(
    listener: (
      requestId: RequestId,
      event: Extract<LifecycleEvent, { type: 'decided' | 'cancelled' | 'agent-disconnected' }>,
    ) => void,
  ): void;
}

/** WHY: adapters are separate packages that must expose one normalized
 * ingress/egress so transports can stay adapter-agnostic (ADR-005). */
export interface AgentAdapter {
  readonly agentKind: string;
  /** Adapter translates its native decision rendering; here just the request. */
  deliverDecision(decision: Extract<LifecycleEvent, { type: 'decided' }>['decision']): void;
}

/** WHY: loopback HTTP vs relay WS vs (phase 4) other transports. */
export interface Transport {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type { DecisionKind };
