import type { Clock } from '../clock.ts';
import type { CrmGateway } from '../crm/hubspot.ts';
import type { LeadRow, Repository } from '../db/repository.ts';
import type { InboundLead, LeadStatus, Route } from '../domain/types.ts';
import type { LeadExtractor } from '../extraction/extract.ts';
import { maskEmail, type Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import { describeError, inspectError, OperationFailedError } from '../reliability/errors.ts';
import type { KeyedMutex } from '../reliability/keyed-mutex.ts';
import type { PostedMessage, SlackNotifier } from '../slack/notifier.ts';
import { crmLockKey, syncLeadToCrm, type CrmSyncContext } from './crm-sync.ts';
import { decideRoute, isPriority } from './route.ts';

export interface PipelineSettings {
  minConfidence: number;
  pipelineId: string;
  stageNew: string;
  mergeWindowDays: number;
  freeMailDomains: ReadonlySet<string>;
}

export interface ProcessorDeps {
  repo: Repository;
  extractor: LeadExtractor;
  crm: CrmGateway;
  slack: SlackNotifier;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  mutex: KeyedMutex;
  settings: PipelineSettings;
}

export interface IngestResult {
  leadId: number;
  duplicate: boolean;
  status: LeadStatus;
}

export interface ProcessResult {
  leadId: number;
  status: LeadStatus;
  route: Route | null;
  merged: boolean;
  latencyMs: number;
  deadLetterId: number | null;
}

export interface LeadProcessor {
  /** Persists the lead or recognises a replay. Synchronous, so a webhook can answer straight after. */
  ingest: (lead: InboundLead) => IngestResult;
  /** Extract, route, write to HubSpot and post to Slack. Never throws: failures end in the dead letter table. */
  process: (leadId: number) => Promise<ProcessResult>;
}

const FINISHED: ReadonlySet<LeadStatus> = new Set(['drafted', 'merged', 'needs_review', 'support', 'spam', 'approved', 'not_a_fit']);

export const crmContextFrom = (deps: Pick<ProcessorDeps, 'crm' | 'repo' | 'clock' | 'logger' | 'settings'>): CrmSyncContext => ({
  crm: deps.crm,
  repo: deps.repo,
  clock: deps.clock,
  logger: deps.logger,
  pipelineId: deps.settings.pipelineId,
  mergeWindowDays: deps.settings.mergeWindowDays,
  freeMailDomains: deps.settings.freeMailDomains,
});

export const createLeadProcessor = (deps: ProcessorDeps): LeadProcessor => {
  const { repo, clock, metrics } = deps;
  const crmContext = crmContextFrom(deps);

  const reload = (leadId: number): LeadRow => {
    const lead = repo.getLead(leadId);
    if (!lead) {
      throw new Error(`Lead ${String(leadId)} not found`);
    }
    return lead;
  };

  const ingest = (lead: InboundLead): IngestResult => {
    const { created, lead: row } = repo.claimLead(lead, clock.now());
    if (!created) {
      repo.recordDuplicateHit(row.id, clock.now());
      metrics.inc('leads.duplicate_blocked');
      deps.logger.info('lead.duplicate_blocked', { leadId: row.id, key: row.idempotencyKey, status: row.status });
      return { leadId: row.id, duplicate: true, status: row.status };
    }
    metrics.inc('leads.received');
    deps.logger.info('lead.received', { leadId: row.id, key: row.idempotencyKey, source: row.source, email: maskEmail(lead.hints.email) });
    return { leadId: row.id, duplicate: false, status: row.status };
  };

  const process = async (leadId: number): Promise<ProcessResult> => {
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);
    const initial = reload(leadId);
    if (FINISHED.has(initial.status)) {
      return { leadId, status: initial.status, route: initial.route, merged: initial.mergedIntoDealId !== null, latencyMs: 0, deadLetterId: null };
    }
    const log = deps.logger.child({ leadId, key: initial.idempotencyKey, source: initial.source });
    repo.markProcessing(leadId, clock.now());
    let stage = 'extract';
    let route: Route | null = initial.route;

    try {
      const decision = initial.decision ?? (await deps.extractor.extract(initial.inbound));
      route = initial.route ?? decideRoute(decision, initial.inbound, deps.settings.minConfidence);
      repo.saveDecision(leadId, decision, route, isPriority(decision.extraction), clock.now());
      let lead = reload(leadId);
      let status: LeadStatus;
      let merged = false;
      let posted: PostedMessage | null = null;

      switch (route) {
        case 'spam':
          status = 'spam';
          break;
        case 'support':
          stage = 'slack.support_notice';
          posted = lead.slackTs ? null : await deps.slack.postSupportNotice(lead);
          status = 'support';
          break;
        case 'human_review':
          stage = 'slack.review_card';
          posted = lead.slackTs ? null : await deps.slack.postLeadCard(lead);
          status = 'needs_review';
          break;
        case 'auto_draft': {
          stage = 'crm';
          const lockKey = crmLockKey(lead, decision.extraction, deps.settings.freeMailDomains);
          const current = lead;
          const sync = await deps.mutex.runExclusive(lockKey, async () => syncLeadToCrm(crmContext, current, decision, deps.settings.stageNew));
          lead = reload(leadId);
          merged = sync.merged;
          stage = merged ? 'slack.merge_notice' : 'slack.lead_card';
          if (!lead.slackTs) {
            posted = merged
              ? await deps.slack.postMergeNotice(lead, repo.getLeadThatCreatedDeal(sync.dealId))
              : await deps.slack.postLeadCard(lead);
          }
          status = merged ? 'merged' : 'drafted';
          break;
        }
      }

      if (posted) {
        repo.saveSlackCard(leadId, posted.channel, posted.ts, clock.now());
      }
      const latencyMs = elapsed();
      repo.completeLead(leadId, status, clock.now(), latencyMs);
      metrics.inc(`leads.${status}`);
      log.info('lead.processed', {
        status,
        route,
        latencyMs,
        method: decision.method,
        fallbackReason: decision.fallbackReason,
        dedupeMatch: lead.dedupeMatch,
      });
      return { leadId, status, route, merged, latencyMs, deadLetterId: null };
    } catch (error) {
      const info = inspectError(error);
      const failedAt = error instanceof OperationFailedError ? error.label : stage;
      const attempts = error instanceof OperationFailedError ? error.attempts : 1;
      const deadLetterId = repo.deadLetter(
        { leadId, stage: failedAt, error: describeError(error), httpStatus: info.status, attempts },
        clock.now(),
      );
      const latencyMs = elapsed();
      repo.completeLead(leadId, 'dead_lettered', clock.now(), latencyMs);
      metrics.inc('leads.dead_lettered');
      log.error('lead.dead_lettered', { deadLetterId, stage: failedAt, attempts, status: info.status, error: describeError(error) });
      try {
        await deps.slack.postAlert({
          leadId,
          deadLetterId,
          stage: failedAt,
          attempts,
          status: info.status === null ? info.kind : `HTTP ${String(info.status)}`,
        });
      } catch (alertError) {
        log.error('alert.failed', { error: describeError(alertError) });
      }
      return { leadId, status: 'dead_lettered', route, merged: false, latencyMs, deadLetterId };
    }
  };

  return { ingest, process };
};
