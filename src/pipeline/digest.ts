import { HOUR_MS, MINUTE_MS, type Clock } from '../clock.ts';
import type { Repository } from '../db/repository.ts';
import type { Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import { isDailyRunDue, localDateKey, localDateLabel, type DailySchedule } from '../scheduler/time.ts';
import { leadTitle, type DigestView } from '../slack/blocks.ts';
import type { SlackNotifier } from '../slack/notifier.ts';

export interface DigestDeps {
  repo: Repository;
  slack: SlackNotifier;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  schedule: DailySchedule;
}

/** Yesterday at a glance: the 24 hours before `now`, plus everything still waiting for a person. */
export const buildDigestView = (repo: Repository, now: Date, timeZone: string): DigestView => {
  // The window ends just after `now`, so a lead received at the digest instant is counted.
  const leads = repo.listLeadsReceivedBetween(new Date(now.getTime() - 24 * HOUR_MS).toISOString(), new Date(now.getTime() + 1).toISOString());
  const waiting = repo.listAwaitingDecision().map((lead) => ({
    leadId: lead.id,
    title: leadTitle(lead),
    ageMinutes: (now.getTime() - Date.parse(lead.cardPostedAt ?? lead.receivedAt)) / MINUTE_MS,
    status: lead.status,
  }));
  return {
    dateLabel: localDateLabel(now, timeZone),
    received: leads.length,
    autoDrafted: leads.filter((lead) => lead.route === 'auto_draft' && lead.mergedIntoDealId === null).length,
    needsReview: leads.filter((lead) => lead.route === 'human_review').length,
    approved: leads.filter((lead) => lead.status === 'approved').length,
    notAFit: leads.filter((lead) => lead.status === 'not_a_fit').length,
    merged: leads.filter((lead) => lead.mergedIntoDealId !== null).length,
    spam: leads.filter((lead) => lead.route === 'spam').length,
    support: leads.filter((lead) => lead.route === 'support').length,
    duplicatesBlocked: leads.reduce((total, lead) => total + lead.duplicateHits, 0),
    deadLettersPending: repo.countPendingDeadLetters(),
    waitingTotal: waiting.length,
    waiting: waiting.slice(0, 8),
  };
};

/**
 * Posts the digest once per local day, at or after the scheduled time. The
 * digests table makes it idempotent across restarts and scheduler ticks.
 */
export const runDigestIfDue = async (deps: DigestDeps): Promise<{ posted: boolean; date: string }> => {
  const now = deps.clock.now();
  const date = localDateKey(now, deps.schedule.timeZone);
  if (!isDailyRunDue(now, deps.schedule) || !deps.repo.claimDigest(date, now)) {
    return { posted: false, date };
  }
  try {
    const posted = await deps.slack.postDigest(buildDigestView(deps.repo, now, deps.schedule.timeZone));
    deps.repo.completeDigest(date, posted.ts);
    deps.metrics.inc('digests.posted');
    deps.logger.info('digest.posted', { date });
    return { posted: true, date };
  } catch (error) {
    deps.repo.releaseDigest(date);
    throw error;
  }
};
