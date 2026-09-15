/**
 * @raag/domain — framework-independent core: identity/aggregate types, the
 * pure approval state machine, audit event vocabulary, and the ports the
 * domain owns (Clock, IdGenerator, ApprovalRepository, AuditSink).
 *
 * Contains NO storage, transport, vendor, or process code — enforced by
 * eslint (no imports outside "./" allowed under packages/domain/src) and by
 * a meta-test.
 */
export * from './action.js';
export * from './audit.js';
export * from './decision.js';
export * from './errors.js';
export * from './identity.js';
export * from './ids.js';
export * from './machine.js';
export * from './policy.js';
export * from './ports.js';
export * from './request.js';
export * from './risk.js';
export * from './states.js';
export * from './time.js';

export const packageName = '@raag/domain' as const;
