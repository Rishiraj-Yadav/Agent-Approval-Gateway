/**
 * @raag/telegram — Telegram ApprovalChannel/NotificationProvider. The ONLY package allowed to import the Telegram SDK, and it exposes no types beyond domain ports (ADR-011 chooses the SDK).
 *
 * Phase 1 scaffold: placeholders only. Implementation per
 * docs/architecture.md lands in Phase 2+.
 */
import { packageName as domain } from '@raag/domain';

export const packageName = '@raag/telegram' as const;
export const builtOn = domain;
