/**
 * @raag/telegram-bot — Optional separate-process Telegram bot half for split deployments; consumes only channel ports (architecture.md §19).
 *
 * Phase 1 scaffold: placeholders only. Implementation per
 * docs/architecture.md lands in Phase 2+.
 */
import { packageName as telegram } from '@raag/telegram';

export const appName = '@raag/telegram-bot' as const;
export function identity(): readonly string[] {
  return [appName, telegram];
}
