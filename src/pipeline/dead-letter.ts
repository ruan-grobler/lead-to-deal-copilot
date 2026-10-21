import { MINUTE_MS, type Clock } from '../clock.ts';
import type { DeadLetterRow, Repository } from '../db/repository.ts';
import type { Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import type { JobQueue } from '../reliability/job-queue.ts';
import type { LeadProcessor, ProcessResult } from './processor.ts';

export interface ReplayDeps {
  repo: Repository;
  processor: LeadProcessor;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
}

export interface ReplayResult {
  deadLetter: DeadLetterRow;
  result: ProcessResult;
}

export interface ReplaySummary {
  attempted: number;
  succeeded: number;
  failed: number;
  results: ReplayResult[];
}

/**
 * Re-runs dead lettered leads. Safe to run any number of times: the stored
 * extraction is reused (no second AI call) and the CRM checkpoints mean
 * records that already exist are not created again.
 */
export const replayDeadLetters = async (deps: ReplayDeps, options: { deadLetterId?: number } = {}): Promise<ReplaySummary> => {
  const candidates =
    options.deadLetterId === undefined
      ? deps.repo.listDeadLetters({ pendingOnly: true })
      : [deps.repo.getDeadLetter(options.deadLetterId)].filter((row): row is DeadLetterRow => row !== null && row.replayedAt === null);
  const results: ReplayResult[] = [];
  for (const deadLetter of candidates) {
    const result = await deps.processor.process(deadLetter.leadId);
    const outcome = result.status === 'dead_lettered' ? `failed again, see dead letter ${String(result.deadLetterId)}` : `ok: ${result.status}`;
    deps.repo.markReplayed(deadLetter.id, outcome, deps.clock.now());
    deps.metrics.inc(result.status === 'dead_lettered' ? 'replay.failed' : 'replay.succeeded');
    deps.logger.info('dead_letter.replayed', { deadLetterId: deadLetter.id, leadId: deadLetter.leadId, outcome });
    results.push({ deadLetter, result });
  }
  const failed = results.filter((item) => item.result.status === 'dead_lettered').length;
  return { attempted: results.length, succeeded: results.length - failed, failed, results };
};

/**
 * Startup recovery after a crash. Leads that never started are queued again.
 * Leads that stopped half way are dead lettered with an alert, so a message
 * that crashes the process cannot put it in a restart loop.
 */
export const recoverInterruptedLeads = (
  deps: ReplayDeps & { queue: JobQueue },
  olderThanMinutes: number,
): { requeued: number; deadLettered: number } => {
  const now = deps.clock.now();
  const cutoff = new Date(now.getTime() - olderThanMinutes * MINUTE_MS).toISOString();
  let requeued = 0;
  let deadLettered = 0;
  for (const lead of deps.repo.listInterrupted(cutoff)) {
    if (lead.status === 'received') {
      deps.queue.push(async () => {
        await deps.processor.process(lead.id);
      });
      requeued += 1;
    } else {
      deps.repo.deadLetter(
        { leadId: lead.id, stage: 'interrupted', error: 'The process stopped before this lead finished', httpStatus: null, attempts: lead.attempts },
        now,
      );
      deadLettered += 1;
    }
  }
  if (requeued > 0 || deadLettered > 0) {
    deps.logger.warn('recovery.done', { requeued, deadLettered });
  }
  return { requeued, deadLettered };
};
