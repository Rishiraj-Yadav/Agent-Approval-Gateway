import { DomainError } from './errors.js';

/**
 * Policy vocabulary only — the Policy Engine itself is Phase 3.
 *
 * Precedence contract (security.md §1-9, architecture.md §13): a local
 * `auto-deny` rule short-circuits before any human prompt; local deny rules
 * are irrevocable remotely. `auto-allow` may only come from explicitly
 * author-written local rules — never from agent input, never as a fallback.
 */
export const POLICY_OUTCOMES = ['auto-allow', 'auto-deny', 'need-human'] as const;
export type PolicyOutcome = (typeof POLICY_OUTCOMES)[number];

export function parsePolicyOutcome(raw: unknown, field = 'policy.outcome'): PolicyOutcome {
  if (typeof raw === 'string' && (POLICY_OUTCOMES as readonly string[]).includes(raw)) {
    return raw as PolicyOutcome;
  }
  throw new DomainError(
    'invalid-policy',
    field,
    `policy outcome must be one of: ${POLICY_OUTCOMES.join(', ')}`,
  );
}
