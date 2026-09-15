/**
 * Deterministic, secret-free domain errors.
 *
 * Domain errors carry an error code, the offending field name, and a static
 * description — NEVER the rejected value (values may contain secrets or
 * hostile agent data). See security.md §1-10.
 */
export type DomainErrorCode =
  | 'invalid-id'
  | 'invalid-identifier-set'
  | 'invalid-timestamp'
  | 'invalid-duration'
  | 'invalid-risk'
  | 'invalid-agent-identity'
  | 'invalid-action'
  | 'invalid-request'
  | 'invalid-decision'
  | 'invalid-state'
  | 'invalid-audit-event'
  | 'invalid-policy'
  | 'invalid-config';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly field: string;

  constructor(code: DomainErrorCode, field: string, detail: string) {
    // `detail` must be static text only, never raw input.
    super(`${code} [${field}] ${detail}`);
    this.name = 'DomainError';
    this.code = code;
    this.field = field;
  }
}
