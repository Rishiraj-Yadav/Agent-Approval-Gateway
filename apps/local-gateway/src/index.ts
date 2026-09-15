import { packageName as core } from '@raag/core';

/**
 * @raag/local-gateway — the local trust-boundary process (architecture.md
 * §7/§9, Phase 3 durable foundation):
 *
 *  config → sqlite store (migrate/integrity/reconcile) → GatewayCore
 *  (envelope authN + replay guard + scope re-checks, dispatching to the
 *  application ApprovalManager) → named pipe / UDS IPC server.
 *
 * Telegram is NOT wired here (that is the channel-package phase). The local
 * decision/cancel/status ingress exists because the gateway must be testable
 * end-to-end and the hook/CLI adapters need it; frames are authenticated
 * exactly like every other one (ADR-034).
 */
export const appName = '@raag/local-gateway' as const;

export function identity(): readonly string[] {
  return [appName, core];
}

export {
  GatewayCore,
  DEFAULT_SWEEP_INTERVAL_MS,
  MAX_CONNECTIONS,
  parseRequestIdOrUndefined,
  type CloseDecision,
  type Emit,
  type ErrorReason,
  type GatewayCoreDeps,
} from './gateway-core.js';
export { WaiterRegistry, MAX_WAITERS, WAITER_GRACE_MS } from './waiters.js';
export { LocalGateway, type LocalGatewayOptions } from './ipc-server.js';
export { defaultIpcPath } from './ipc-default.js';
export { GatewayClient } from './client.js';
export { main } from './main.js';
