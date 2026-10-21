import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recoverInterruptedLeads, replayDeadLetters } from '../../src/pipeline/dead-letter.ts';
import { FormSubmissionSchema, formSubmissionToLead } from '../../src/sources/form.ts';
import { createHarness, extraction, formPayload, type Harness } from '../helpers/harness.ts';

const ingestForm = async (h: Harness, overrides: Record<string, string> = {}): Promise<{ leadId: number; duplicate: boolean }> => {
  const lead = formSubmissionToLead(FormSubmissionSchema.parse(formPayload(overrides)), h.clock.now());
  const outcome = h.runtime.processor.ingest(lead);
  if (!outcome.duplicate) {
    await h.runtime.processor.process(outcome.leadId);
  }
  return outcome;
};

const hubspotWrites = (h: Harness): number => h.hubspot.requests.filter((request) => request.method !== 'GET' && !request.path.endsWith('/search') && !request.path.endsWith('/batch/read')).length;

describe('lead pipeline end to end against the mocks', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('turns a clean lead into a contact, company, deal and note, all associated, plus a Slack card', async () => {
    const { leadId } = await ingestForm(h, { phone: '+27 00 000 0031', website: 'https://test-company.example.com' });
    const lead = h.runtime.repo.getLead(leadId);
    expect(lead).toMatchObject({ status: 'drafted', route: 'auto_draft', dedupeMatch: 'none' });
    expect(lead?.latencyMs).toBeGreaterThanOrEqual(0);

    const [contact] = [...h.hubspot.objects.contacts.values()];
    const [company] = [...h.hubspot.objects.companies.values()];
    const [deal] = [...h.hubspot.objects.deals.values()];
    const [note] = [...h.hubspot.objects.notes.values()];
    expect(contact?.properties).toMatchObject({ email: 'test.person@test-company.example.com', firstname: 'Test', lastname: 'Person', phone: '+27000000031', lifecyclestage: 'lead' });
    expect(company?.properties).toMatchObject({ name: 'Test Company', domain: 'test-company.example.com' });
    expect(deal?.properties).toMatchObject({ dealstage: 'appointmentscheduled', pipeline: 'default', dealname: 'Test Company: Managed IT support for 20 staff' });
    expect(deal?.properties.description).toContain(`lead ${String(leadId)} (form:`);
    expect(h.hubspot.associationsOf('deals', deal?.id ?? '', 'contacts')).toEqual([contact?.id]);
    expect(h.hubspot.associationsOf('deals', deal?.id ?? '', 'companies')).toEqual([company?.id]);
    expect(h.hubspot.associationsOf('contacts', contact?.id ?? '', 'companies')).toEqual([company?.id]);
    expect(h.hubspot.associationsOf('notes', note?.id ?? '', 'deals')).toEqual([deal?.id]);
    expect(note?.properties.hs_note_body).toContain('We need managed IT support for 20 staff');

    const cards = h.slack.topLevel('#sales');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.text).toContain('New lead: Test Company');
    expect(lead?.slackTs).toBe(cards[0]?.ts);
    expect(h.logs.some((line) => line.includes('"msg":"lead.processed"'))).toBe(true);
  });

  it('never creates a second deal for a replayed message', async () => {
    const first = await ingestForm(h, { submissionId: 'same' });
    const second = await ingestForm(h, { submissionId: 'same' });
    expect(second).toEqual({ leadId: first.leadId, duplicate: true, status: 'drafted' });
    const again = await h.runtime.processor.process(first.leadId);
    expect(again.latencyMs).toBe(0);
    expect(h.hubspot.objects.deals.size).toBe(1);
    expect(h.slack.messages).toHaveLength(1);
    expect(h.runtime.repo.getLead(first.leadId)?.duplicateHits).toBe(1);
  });

  it('merges a second message from the same person into the open deal', async () => {
    const first = await ingestForm(h);
    const second = await ingestForm(h, { message: 'Following up: please add backups to the quote.' });
    const lead = h.runtime.repo.getLead(second.leadId);
    expect(lead).toMatchObject({ status: 'merged', dedupeMatch: 'contact_email', mergedIntoDealId: h.runtime.repo.getLead(first.leadId)?.dealId });
    expect(h.hubspot.objects.deals.size).toBe(1);
    expect(h.hubspot.objects.contacts.size).toBe(1);
    expect(h.hubspot.objects.notes.size).toBe(2);
    const reply = h.slack.threadReplies('#sales')[0];
    expect(reply?.threadTs).toBe(h.runtime.repo.getLead(first.leadId)?.slackTs);
    expect(reply?.text).toContain('matched an open deal by email address');
  });

  it('merges a colleague from the same company domain and adds them to the deal', async () => {
    await ingestForm(h);
    h.setAi(() => ({ kind: 'extraction', extraction: extraction({ name: ['Second Person', 0.95], email: ['second.person@test-company.example.com', 0.97] }) }));
    const colleague = await ingestForm(h, { name: 'Second Person', email: 'second.person@test-company.example.com' });
    const lead = h.runtime.repo.getLead(colleague.leadId);
    expect(lead).toMatchObject({ status: 'merged', dedupeMatch: 'company_domain' });
    expect(h.hubspot.objects.contacts.size).toBe(2);
    expect(h.hubspot.objects.companies.size).toBe(1);
    const dealId = lead?.dealId ?? '';
    expect(h.hubspot.associationsOf('deals', dealId, 'contacts')).toHaveLength(2);
  });

  it('opens a new deal when the only earlier deal is closed, and fills gaps without overwriting', async () => {
    const contact = h.hubspot.seedContact({ email: 'test.person@test-company.example.com', firstname: 'Existing', lastname: 'Name' });
    h.hubspot.seedDeal({ dealname: 'Old', dealstage: 'closedwon', pipeline: 'default' }, { contactId: contact.id });
    h.setAi(() => ({ kind: 'extraction', extraction: extraction({ phone: ['+27 00 000 0032', 0.95] }) }));
    const { leadId } = await ingestForm(h, { phone: '+27 00 000 0032' });
    expect(h.runtime.repo.getLead(leadId)).toMatchObject({ status: 'drafted', dedupeMatch: 'contact_email', contactId: contact.id });
    expect(h.hubspot.objects.contacts.get(contact.id)?.properties).toMatchObject({ firstname: 'Existing', lastname: 'Name', phone: '+27000000032' });
    expect(h.hubspot.objects.deals.size).toBe(2);
  });

  it('sends an AI failure to human review without touching HubSpot', async () => {
    h.setAi(() => ({ kind: 'http_error', status: 500, errorType: 'api_error', message: 'boom' }));
    const { leadId } = await ingestForm(h);
    const lead = h.runtime.repo.getLead(leadId);
    expect(lead).toMatchObject({ status: 'needs_review', route: 'human_review' });
    expect(lead?.decision).toMatchObject({ method: 'rules', fallbackReason: 'api_error' });
    expect(hubspotWrites(h)).toBe(0);
    expect(h.slack.topLevel('#sales')[0]?.text).toContain('Needs review');
    expect(h.runtime.metrics.get('ai.fallback.api_error')).toBe(1);
  });

  it('filters spam and routes support without creating deals', async () => {
    h.setAi(() => ({ kind: 'extraction', extraction: extraction({ intent: { value: 'spam', confidence: 0.97 } }) }));
    const spam = await ingestForm(h);
    h.setAi(() => ({ kind: 'extraction', extraction: extraction({ intent: { value: 'support', confidence: 0.95 } }) }));
    const support = await ingestForm(h);
    expect(h.runtime.repo.getLead(spam.leadId)?.status).toBe('spam');
    expect(h.runtime.repo.getLead(support.leadId)?.status).toBe('support');
    expect(hubspotWrites(h)).toBe(0);
    expect(h.slack.topLevel('#support')).toHaveLength(1);
    expect(h.slack.topLevel('#sales')).toHaveLength(0);
  });

  it('dead letters a lead after a 429 storm, alerts, and the replay finishes it once', async () => {
    h.hubspot.startRateLimitStorm(3);
    const { leadId } = await ingestForm(h);
    expect(h.runtime.repo.getLead(leadId)?.status).toBe('dead_lettered');
    const [deadLetter] = h.runtime.repo.listDeadLetters();
    expect(deadLetter).toMatchObject({ leadId, stage: 'hubspot.contacts.search', httpStatus: 429, attempts: 3 });
    expect(h.slack.topLevel('#sales-ops')[0]?.text).toContain('npm run replay');

    const summary = await replayDeadLetters(h.runtime);
    expect(summary).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
    expect(h.runtime.repo.getLead(leadId)?.status).toBe('drafted');
    expect(h.runtime.repo.countPendingDeadLetters()).toBe(0);
    expect(h.runtime.repo.getDeadLetter(deadLetter?.id ?? 0)?.replayOutcome).toBe('ok: drafted');
    expect(h.anthropic.calls).toHaveLength(1);
    expect((await replayDeadLetters(h.runtime)).attempted).toBe(0);
  });

  it('resumes from the checkpoint after a failure half way, so the replay creates no duplicates', async () => {
    h.hubspot.failPath('POST', '/crm/v3/objects/notes', 500, 3);
    const { leadId } = await ingestForm(h);
    const stuck = h.runtime.repo.getLead(leadId);
    expect(stuck).toMatchObject({ status: 'dead_lettered', noteId: null });
    expect(stuck?.dealId).not.toBeNull();
    expect(h.runtime.repo.listDeadLetters()[0]?.stage).toBe('hubspot.notes.create');

    const replay = await replayDeadLetters(h.runtime, { deadLetterId: h.runtime.repo.listDeadLetters()[0]?.id ?? 0 });
    expect(replay.succeeded).toBe(1);
    expect(h.hubspot.objects.contacts.size).toBe(1);
    expect(h.hubspot.objects.companies.size).toBe(1);
    expect(h.hubspot.objects.deals.size).toBe(1);
    expect(h.hubspot.objects.notes.size).toBe(1);
    expect(h.runtime.repo.getLead(leadId)?.dealId).toBe(stuck?.dealId);
  });

  it('dead letters when Slack is down after HubSpot succeeded, and the replay only posts the card', async () => {
    h.slack.failNext(3, 503);
    const { leadId } = await ingestForm(h);
    expect(h.runtime.repo.getLead(leadId)?.status).toBe('dead_lettered');
    expect(h.runtime.repo.listDeadLetters()[0]?.stage).toBe('slack.chat.postMessage');
    const writesBefore = hubspotWrites(h);
    await replayDeadLetters(h.runtime);
    expect(h.runtime.repo.getLead(leadId)?.status).toBe('drafted');
    expect(hubspotWrites(h)).toBe(writesBefore);
    expect(h.slack.topLevel('#sales')).toHaveLength(1);
  });

  it('a replay that fails again stays visible as a new dead letter', async () => {
    h.hubspot.startRateLimitStorm(6);
    await ingestForm(h);
    const summary = await replayDeadLetters(h.runtime);
    expect(summary).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(h.runtime.repo.countPendingDeadLetters()).toBe(1);
    expect(summary.results[0]?.deadLetter.id).toBe(1);
    expect(h.runtime.repo.getDeadLetter(1)?.replayOutcome).toBe('failed again, see dead letter 2');
  });

  it('still records the dead letter when the alert itself cannot be sent', async () => {
    h.hubspot.startRateLimitStorm(3);
    h.slack.failNext(3, 500);
    const { leadId } = await ingestForm(h);
    expect(h.runtime.repo.getLead(leadId)?.status).toBe('dead_lettered');
    expect(h.logs.some((line) => line.includes('"msg":"alert.failed"'))).toBe(true);
  });

  it('retries a Slack rate limit, honouring Retry-After', async () => {
    h.slack.rateLimitNext(1, 0);
    const { leadId } = await ingestForm(h);
    expect(h.runtime.repo.getLead(leadId)?.status).toBe('drafted');
    expect(h.runtime.metrics.get('retry.scheduled.slack.chat.postMessage')).toBe(1);
  });

  it('serialises concurrent leads for the same company, so they cannot race into two deals', async () => {
    const leads = [formPayload({ email: 'a@race.example.com', message: 'first' }), formPayload({ email: 'b@race.example.com', message: 'second' })].map((payload) =>
      formSubmissionToLead(FormSubmissionSchema.parse(payload), h.clock.now()),
    );
    let call = 0;
    h.setAi(() => {
      call += 1;
      const email = call === 1 ? 'a@race.example.com' : 'b@race.example.com';
      return { kind: 'extraction', extraction: extraction({ email: [email, 0.97] }) };
    });
    const ids = leads.map((lead) => h.runtime.processor.ingest(lead).leadId);
    await Promise.all(ids.map(async (id) => h.runtime.processor.process(id)));
    expect(h.hubspot.objects.companies.size).toBe(1);
    expect(h.hubspot.objects.deals.size).toBe(1);
    expect(ids.map((id) => h.runtime.repo.getLead(id)?.status).sort()).toEqual(['drafted', 'merged']);
  });

  it('recovers after a crash: requeues leads that never started, dead letters ones that stopped half way', async () => {
    const received = h.runtime.processor.ingest(formSubmissionToLead(FormSubmissionSchema.parse(formPayload()), h.clock.now()));
    const halfway = h.runtime.processor.ingest(formSubmissionToLead(FormSubmissionSchema.parse(formPayload({ email: 'other@other.example.com' })), h.clock.now()));
    h.runtime.repo.markProcessing(halfway.leadId, h.clock.now());
    h.clock.advance(60_000);
    const result = recoverInterruptedLeads({ ...h.runtime }, 0);
    expect(result).toEqual({ requeued: 1, deadLettered: 1 });
    await h.runtime.queue.onIdle();
    expect(h.runtime.repo.getLead(received.leadId)?.status).toBe('drafted');
    expect(h.runtime.repo.getLead(halfway.leadId)?.status).toBe('dead_lettered');
    expect(h.runtime.repo.listDeadLetters()[0]?.stage).toBe('interrupted');
  });
});

describe('AI switched off', () => {
  it('routes every lead to review through the rules when there is no API key', async () => {
    const h = await createHarness({ env: { ANTHROPIC_API_KEY: '' } });
    try {
      const { leadId } = await ingestForm(h);
      expect(h.runtime.repo.getLead(leadId)?.decision?.fallbackReason).toBe('ai_disabled');
      expect(h.anthropic.calls).toHaveLength(0);
      expect(h.logs.some((line) => line.includes('"msg":"ai.disabled"'))).toBe(true);
    } finally {
      await h.close();
    }
  });
});
