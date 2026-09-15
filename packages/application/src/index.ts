/**
 * @raag/application — orchestration layer: the ApprovalManager (the only
 * state-advancing component) and the interaction ports implemented by leaf
 * packages. Domain rules live in @raag/domain; this layer wires them to
 * storage/clock/policy/notification through ports only.
 */
export * from './ports.js';
export {
  ApprovalManager,
  type ApprovalManagerDeps,
  type ResolveResult,
} from './approval-manager.js';

export const packageName = '@raag/application' as const;
