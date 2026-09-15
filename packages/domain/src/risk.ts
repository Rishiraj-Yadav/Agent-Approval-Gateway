/**
 * Risk classification. Deliberately INDEPENDENT of the policy engine:
 * risk describes the intrinsic danger of an action as classified at
 * normalization/submission time; policy decides outcome (Phase 3). Keeping
 * them apart prevents an adapter from smuggling "auto-allow" through a
 * `low` label.
 */
import { DomainError } from './errors.js';

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export function parseRiskLevel(raw: unknown, field = 'risk'): RiskLevel {
  if (typeof raw === 'string') {
    const level = raw.toLowerCase();
    if ((RISK_LEVELS as readonly string[]).includes(level)) {
      return level as RiskLevel;
    }
  }
  throw new DomainError(
    'invalid-risk',
    field,
    `risk must be one of: ${RISK_LEVELS.join(', ')} (missing/unrecognized fail closed)`,
  );
}

/** Relative order for logging/aggregation only — NOT policy. */
export function riskRank(level: RiskLevel): number {
  return RISK_LEVELS.indexOf(level);
}
