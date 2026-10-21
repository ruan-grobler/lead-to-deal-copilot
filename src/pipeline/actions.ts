import type { Clock } from '../clock.ts';
import type { CrmGateway } from '../crm/hubspot.ts';
import type { LeadRow, Repository } from '../db/repository.ts';
import type { Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import { describeError } from '../reliability/errors.ts';
import type { KeyedMutex } from '../reliability/keyed-mutex.ts';
import type { SlackNotifier } from '../slack/notifier.ts';
import { crmLockKey, syncLeadToCrm } from './crm-sync.ts';
import { crmContextFrom, type PipelineSettings } from './processor.ts';

export interface ActionOutcome {
  ok: boolean;
  message: string;
  lead: LeadRow | null;
}

export interface LeadActions {
  approve: (leadId: number, userId: string) => Promise<ActionOutcome>;
  notAFit: (leadId: number, userId: string) => Promise<ActionOutcome>;
  assign: (leadId: number, userId: string) => Promise<ActionOutcome>;
}

export interface LeadActionsDeps {
  repo: Repository;
  crm: CrmGateway;
  slack: SlackNotifier;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  mutex: KeyedMutex;
  settings: PipelineSettings;
  stages: { approved: string; notAFit: string };
}

const alreadyDecided = (lead: LeadRow): ActionOutcome => ({
  ok: false,
  message:
    lead.status === 'approved'
      ? `Lead ${String(lead.id)} was already approved${lead.decidedBy ? ` by <@${lead.decidedBy}>` : ''}.`
      : `Lead ${String(lead.id)} was already marked not a fit${lead.decidedBy ? ` by <@${lead.decidedBy}>` : ''}.`,
  lead,
});

/**
 * What the three Slack buttons do. Each one claims the decision in SQLite
 * first (a conditional update), so a double click or two people clicking at
 * once cannot write to HubSpot twice. If HubSpot fails, the claim is undone.
 */
export const createLeadActions = (deps: LeadActionsDeps): LeadActions => {
  const { repo, clock } = deps;
  const crmContext = crmContextFrom(deps);

  const refreshCard = async (leadId: number): Promise<LeadRow | null> => {
    const lead = repo.getLead(leadId);
    if (lead) {
      try {
        await deps.slack.updateLeadCard(lead);
      } catch (error) {
        deps.logger.warn('slack.card_update_failed', { leadId, error: describeError(error) });
      }
    }
    return lead;
  };

  /** Maps the Slack user to a HubSpot owner by email. Returns a note for the person who clicked. */
  const setOwnerBestEffort = async (leadId: number, dealId: string, userId: string): Promise<string> => {
    try {
      const email = await deps.slack.getUserEmail(userId);
      const ownerId = email ? await deps.crm.findOwnerIdByEmail(email) : null;
      if (!ownerId) {
        return 'No HubSpot user has your Slack email address, so the deal owner did not change.';
      }
      await deps.crm.updateDeal(dealId, { hubspot_owner_id: ownerId });
      return 'You are now the deal owner in HubSpot.';
    } catch (error) {
      deps.logger.warn('action.owner_update_failed', { leadId, error: describeError(error) });
      return 'HubSpot did not accept the owner change, so the deal owner did not change.';
    }
  };

  const decide = async (
    leadId: number,
    userId: string,
    status: 'approved' | 'not_a_fit',
    crmWrite: (lead: LeadRow) => Promise<void>,
  ): Promise<ActionOutcome> => {
    const lead = repo.getLead(leadId);
    if (!lead) {
      return { ok: false, message: `Lead ${String(leadId)} was not found.`, lead: null };
    }
    if (lead.status === 'approved' || lead.status === 'not_a_fit') {
      return alreadyDecided(lead);
    }
    if (lead.status !== 'drafted' && lead.status !== 'needs_review') {
      return { ok: false, message: `Lead ${String(leadId)} is ${lead.status.replace('_', ' ')}, so there is nothing to decide.`, lead };
    }
    if (!repo.recordDecision(leadId, status, userId, clock.now())) {
      const latest = repo.getLead(leadId);
      return latest ? alreadyDecided(latest) : { ok: false, message: 'Lead disappeared.', lead: null };
    }
    try {
      await crmWrite(lead);
    } catch (error) {
      repo.revertDecision(leadId, lead.status, clock.now());
      deps.logger.error('action.crm_failed', { leadId, status, error: describeError(error) });
      return { ok: false, message: `HubSpot did not accept the change (${describeError(error)}). Nothing was saved, please try again.`, lead: repo.getLead(leadId) };
    }
    deps.metrics.inc(`actions.${status}`);
    deps.logger.info('action.decided', { leadId, status, userId });
    const updated = await refreshCard(leadId);
    const verb = status === 'approved' ? 'Approved' : 'Marked not a fit';
    return { ok: true, message: `${verb}: lead ${String(leadId)}.`, lead: updated };
  };

  return {
    approve: async (leadId, userId) =>
      decide(leadId, userId, 'approved', async (lead) => {
        if (lead.route === 'human_review') {
          const decision = lead.decision;
          if (!decision) {
            throw new Error('Lead has no extraction to create records from');
          }
          // A reviewed lead touches HubSpot only now, after a person vouched for it.
          const lockKey = crmLockKey(lead, decision.extraction, deps.settings.freeMailDomains);
          const sync = await deps.mutex.runExclusive(lockKey, async () => {
            const current = repo.getLead(lead.id) ?? lead;
            return syncLeadToCrm(crmContext, current, decision, deps.stages.approved);
          });
          if (lead.assignedTo && !sync.merged) {
            await setOwnerBestEffort(lead.id, sync.dealId, lead.assignedTo);
          }
          return;
        }
        if (lead.dealId && lead.mergedIntoDealId === null) {
          await deps.crm.updateDeal(lead.dealId, { dealstage: deps.stages.approved });
        }
      }),

    notAFit: async (leadId, userId) =>
      decide(leadId, userId, 'not_a_fit', async (lead) => {
        if (lead.dealId && lead.mergedIntoDealId === null) {
          await deps.crm.updateDeal(lead.dealId, { dealstage: deps.stages.notAFit });
        }
      }),

    assign: async (leadId, userId) => {
      const lead = repo.getLead(leadId);
      if (!lead) {
        return { ok: false, message: `Lead ${String(leadId)} was not found.`, lead: null };
      }
      if (!repo.recordAssignment(leadId, userId, clock.now())) {
        return { ok: false, message: `Lead ${String(leadId)} is already assigned to <@${lead.assignedTo ?? 'someone'}>.`, lead };
      }
      const ownerNote =
        lead.dealId && lead.mergedIntoDealId === null
          ? await setOwnerBestEffort(leadId, lead.dealId, userId)
          : 'The HubSpot deal is created when the lead is approved, and you become its owner then.';
      deps.metrics.inc('actions.assigned');
      deps.logger.info('action.assigned', { leadId, userId });
      const updated = await refreshCard(leadId);
      return { ok: true, message: `Lead ${String(leadId)} is assigned to you. ${ownerNote}`, lead: updated };
    },
  };
};
