import type { Clock } from '../clock.ts';
import type { CrmGateway, CrmProperties, CrmRecord } from '../crm/hubspot.ts';
import type { LeadRow, Repository } from '../db/repository.ts';
import { companyDomainFor, companyNameFromDomain, normalizeEmail, normalizePhone, splitName, truncate } from '../domain/normalize.ts';
import type { DedupeMatch, ExtractionDecision } from '../domain/types.ts';
import type { LeadExtraction } from '../extraction/schema.ts';
import type { Logger } from '../logger.ts';
import { BUDGET_LABELS, SOURCE_LABELS, URGENCY_LABELS } from './labels.ts';

export interface CrmSyncContext {
  crm: CrmGateway;
  repo: Repository;
  clock: Clock;
  logger: Logger;
  pipelineId: string;
  mergeWindowDays: number;
  freeMailDomains: ReadonlySet<string>;
}

export interface CrmSyncResult {
  contactId: string;
  companyId: string | null;
  dealId: string;
  noteId: string;
  dedupeMatch: DedupeMatch;
  merged: boolean;
}

const DAY_MS = 86_400_000;

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const contactPropertiesFor = (extraction: LeadExtraction): CrmProperties => {
  const properties: CrmProperties = {};
  const email = normalizeEmail(extraction.email.value);
  if (email) {
    properties.email = email;
  }
  if (extraction.name.value) {
    const { firstname, lastname } = splitName(extraction.name.value);
    properties.firstname = firstname;
    if (lastname) {
      properties.lastname = lastname;
    }
  }
  const phone = normalizePhone(extraction.phone.value);
  if (phone) {
    properties.phone = phone;
  }
  if (extraction.company.value) {
    properties.company = extraction.company.value;
  }
  return properties;
};

/** Clean data rule: fill gaps on an existing contact, never overwrite what a person already entered. */
export const fillEmptyProperties = (existing: Record<string, string | null>, desired: CrmProperties): CrmProperties => {
  const patch: CrmProperties = {};
  for (const [key, value] of Object.entries(desired)) {
    if (key === 'email' || !value) {
      continue;
    }
    const current = existing[key];
    if (current === null || current === undefined || current.trim() === '') {
      patch[key] = value;
    }
  }
  return patch;
};

export const dealNameFor = (extraction: LeadExtraction): string => {
  const who = extraction.company.value ?? extraction.name.value ?? extraction.email.value ?? 'Unknown lead';
  const need = extraction.need.value ? `: ${truncate(extraction.need.value.replace(/\.$/, ''), 60)}` : '';
  return truncate(`${who}${need}`, 100);
};

const dealDescriptionFor = (lead: LeadRow, extraction: LeadExtraction): string =>
  [
    extraction.need.value ? `Need: ${extraction.need.value}` : null,
    `Budget: ${BUDGET_LABELS[extraction.budgetBand.value]}`,
    `Urgency: ${URGENCY_LABELS[extraction.urgency.value]}`,
    `Source: ${SOURCE_LABELS[lead.source]}`,
    lead.priority ? 'Priority: high value lead' : null,
    `Created by Lead to Deal Copilot, lead ${String(lead.id)} (${lead.idempotencyKey})`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

export const noteBodyFor = (lead: LeadRow, decision: ExtractionDecision, merged: boolean): string => {
  const { extraction } = decision;
  const method =
    decision.fallbackReason === null
      ? 'Extracted by Claude'
      : decision.method === 'ai'
        ? `Extracted by Claude, flagged for review (${decision.fallbackReason})`
        : `Extracted by fallback rules (${decision.fallbackReason})`;
  const body = escapeHtml(lead.inbound.text).replace(/\r?\n/g, '<br>');
  return [
    `<p><strong>Inbound lead from ${escapeHtml(SOURCE_LABELS[lead.source])}</strong>${merged ? ', merged into this existing deal' : ''}. Lead ${String(lead.id)}, key ${escapeHtml(lead.idempotencyKey)}.</p>`,
    lead.inbound.subject ? `<p><strong>Subject:</strong> ${escapeHtml(lead.inbound.subject)}</p>` : '',
    `<p>${body}</p>`,
    `<p>${method}. Intent ${extraction.intent.value} (${extraction.intent.confidence.toFixed(2)}), budget ${escapeHtml(BUDGET_LABELS[extraction.budgetBand.value])}, urgency ${extraction.urgency.value}.</p>`,
  ].join('');
};

const findOpenDeal = async (
  ctx: CrmSyncContext,
  contactId: string,
  companyId: string | null,
  dedupeMatch: DedupeMatch,
): Promise<CrmRecord | null> => {
  if (dedupeMatch === 'none') {
    return null;
  }
  const since = new Date(ctx.clock.now().getTime() - ctx.mergeWindowDays * DAY_MS);
  if (dedupeMatch === 'contact_email') {
    const [byContact] = await ctx.crm.findOpenDeals('contacts', contactId, since);
    if (byContact) {
      return byContact;
    }
  }
  if (companyId) {
    const [byCompany] = await ctx.crm.findOpenDeals('companies', companyId, since);
    return byCompany ?? null;
  }
  return null;
};

/** The key that serialises CRM writes for one company, so parallel leads cannot race each other into duplicates. */
export const crmLockKey = (lead: LeadRow, extraction: LeadExtraction, freeMailDomains: ReadonlySet<string>): string => {
  const email = normalizeEmail(extraction.email.value);
  const domain = companyDomainFor(email, lead.inbound.hints.website, freeMailDomains);
  return domain ? `domain:${domain}` : email ? `email:${email}` : `lead:${String(lead.id)}`;
};

/**
 * Upserts contact and company, creates or reuses a deal, associates all three
 * and attaches the source text as a note. Each step writes a checkpoint, so a
 * replay after a failure resumes where it stopped instead of duplicating.
 */
export const syncLeadToCrm = async (
  ctx: CrmSyncContext,
  lead: LeadRow,
  decision: ExtractionDecision,
  dealStage: string,
): Promise<CrmSyncResult> => {
  const { extraction } = decision;
  const email = normalizeEmail(extraction.email.value);
  const desired = contactPropertiesFor(extraction);
  const log = ctx.logger.child({ leadId: lead.id });
  let contactId = lead.contactId;
  let companyId = lead.companyId;
  let dealId = lead.dealId;
  let noteId = lead.noteId;
  let dedupeMatch: DedupeMatch = lead.dedupeMatch ?? 'none';
  let merged = lead.mergedIntoDealId !== null;

  if (!contactId) {
    const existing = email ? await ctx.crm.findContactByEmail(email) : null;
    if (existing) {
      contactId = existing.id;
      dedupeMatch = 'contact_email';
      const patch = fillEmptyProperties(existing.properties, desired);
      if (Object.keys(patch).length > 0) {
        await ctx.crm.updateContact(existing.id, patch);
      }
    } else {
      contactId = (await ctx.crm.createContact({ ...desired, lifecyclestage: 'lead' })).id;
    }
    ctx.repo.saveCrmCheckpoint(lead.id, { contactId, dedupeMatch }, ctx.clock.now());
    log.info('crm.contact', { contactId, dedupeMatch });
  }

  const domain = companyDomainFor(email, lead.inbound.hints.website, ctx.freeMailDomains);
  if (!companyId && domain) {
    const existing = await ctx.crm.findCompanyByDomain(domain);
    if (existing) {
      companyId = existing.id;
      if (dedupeMatch === 'none') {
        dedupeMatch = 'company_domain';
      }
    } else {
      companyId = (await ctx.crm.createCompany({ name: extraction.company.value ?? companyNameFromDomain(domain), domain })).id;
    }
    await ctx.crm.associateContactToCompany(contactId, companyId);
    ctx.repo.saveCrmCheckpoint(lead.id, { companyId, dedupeMatch }, ctx.clock.now());
    log.info('crm.company', { companyId, dedupeMatch });
  }

  if (!dealId) {
    const open = await findOpenDeal(ctx, contactId, companyId, dedupeMatch);
    if (open) {
      dealId = open.id;
      merged = true;
      await ctx.crm.associateDealToContact(dealId, contactId);
      ctx.repo.saveCrmCheckpoint(lead.id, { dealId, mergedIntoDealId: dealId }, ctx.clock.now());
      log.info('crm.deal.merged', { dealId, dedupeMatch });
    } else {
      const deal = await ctx.crm.createDeal({
        properties: {
          dealname: dealNameFor(extraction),
          pipeline: ctx.pipelineId,
          dealstage: dealStage,
          description: dealDescriptionFor(lead, extraction),
        },
        contactId,
        companyId,
      });
      dealId = deal.id;
      ctx.repo.saveCrmCheckpoint(lead.id, { dealId }, ctx.clock.now());
      log.info('crm.deal.created', { dealId, dealStage });
    }
  }

  if (!noteId) {
    const note = await ctx.crm.createNote({
      body: noteBodyFor(lead, decision, merged),
      timestamp: new Date(lead.receivedAt),
      contactId,
      companyId,
      dealId,
    });
    noteId = note.id;
    ctx.repo.saveCrmCheckpoint(lead.id, { noteId }, ctx.clock.now());
  }

  return { contactId, companyId, dealId, noteId, dedupeMatch, merged };
};
