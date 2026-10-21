import { MINUTE_MS, type Clock } from '../clock.ts';
import type { Repository } from '../db/repository.ts';
import type { Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import { describeError } from '../reliability/errors.ts';
import type { SlackNotifier } from '../slack/notifier.ts';

export interface ReminderDeps {
  repo: Repository;
  slack: SlackNotifier;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  remindAfterMinutes: number;
}

/**
 * Posts one threaded reminder on every card nobody has touched (no decision,
 * no owner) for longer than the threshold. Each card is reminded once.
 */
export const runReminderSweep = async (deps: ReminderDeps): Promise<{ reminded: number; failed: number }> => {
  const now = deps.clock.now();
  const cutoff = new Date(now.getTime() - deps.remindAfterMinutes * MINUTE_MS).toISOString();
  let reminded = 0;
  let failed = 0;
  for (const lead of deps.repo.listReminderCandidates(cutoff)) {
    const ageMinutes = (now.getTime() - Date.parse(lead.cardPostedAt ?? lead.receivedAt)) / MINUTE_MS;
    try {
      await deps.slack.postReminder(lead, ageMinutes);
      deps.repo.markReminded(lead.id, now);
      reminded += 1;
      deps.metrics.inc('reminders.sent');
    } catch (error) {
      failed += 1;
      deps.logger.error('reminder.failed', { leadId: lead.id, error: describeError(error) });
    }
  }
  if (reminded > 0 || failed > 0) {
    deps.logger.info('reminders.swept', { reminded, failed });
  }
  return { reminded, failed };
};
