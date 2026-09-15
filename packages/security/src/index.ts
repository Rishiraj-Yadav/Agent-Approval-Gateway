/**
 * @raag/security — redaction and secret-handling primitives. The logging and
 * adapter layers run everything through redaction before it may leave the
 * process (security.md §4); real secrets live in env/config and are designed
 * never to flow through these functions — this is the second layer, not a
 * completeness guarantee (limitations documented in redaction.ts).
 */
export {
  packageName,
  REDACTED,
  redactString,
  redactUnknown,
  isSensitiveFieldName,
} from './redaction.js';
export {
  MAX_CLOCK_SKEW_MS,
  REPLAY_CACHE_MAX,
  ReplayGuard,
  computeMac,
  verifyMac,
  type ReplayDecision,
} from './auth.js';
