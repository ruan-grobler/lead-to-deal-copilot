import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LeadRow } from '../../src/db/repository.ts';
import { ACTION_IDS } from '../../src/slack/blocks.ts';
import { FormSubmissionSchema, formSubmissionToLead } from '../../src/sources/form.ts';
import { blockAction, createHarness, extraction, formPayload, messageShortcut, type Harness } from '../helpers/harness.ts';

const draftLead = async (h: Harness, overrides: Record<string, string> = {}): Promise<LeadRow> => {
  const outcome = h.runtime.processor.ingest(formSubmissionToLead(FormSubmissionSchema.parse(formPayload(overrides)), h.clock.now()));
  await h.runtime.processor.process(outcome.leadId);
  const lead = h.runtime.repo.getLead(outcome.leadId);
  if (!lead) {
    throw new Error('lead missing');
  }
  return lead;
};

const click = async (h: Harness, lead: LeadRow, action: keyof typeof ACTION_IDS, user: string): Promise<LeadRow | null> => {
  await h.receiver.dispatch(blockAction(lead, ACTION_IDS[action], user));
  return h.runtime.repo.getLead(lead.id);
};

const lastEphemeral = (h: Harness): string => h.slack.ephemerals.at(-1)?.text ?? '';

describe('Slack app through Bolt', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
    h.slack.addUser({ id: 'U0AMAHLE', name: 'Amahle', email: 'amahle@northwind-it.example.com' });
    h.slack.addUser({ id: 'U0DANIEL', name: 'Daniel', email: 'daniel@northwind-it.example.com' });
    h.hubspot.addOwner({ id: '7002', email: 'daniel@northwind-it.example.com', firstName: 'Daniel', lastName: 'F' });
  });

  afterEach(async () => {
    await h.close();
  });

  it('turns a message into a lead with the shortcut, once', async () => {
    const body = messageShortcut({ channel: 'C0LEADS', ts: '1760947200.000100', text: 'Lead from the expo: test.person@test-company.example.com wants managed IT for 20 staff.', user: 'U0DANIEL' });
    await h.receiver.dispatch(body);
    await h.runtime.queue.onIdle();
    const lead = h.runtime.repo.getLeadByKey('slack:T0TEST:C0LEADS:1760947200.000100');
    expect(lead).toMatchObject({ source: 'slack', status: 'drafted' });
    expect(lead?.inbound.meta).toMatchObject({ sharedBy: 'U0DANIEL', author: 'U0AUTHOR' });
    expect(lastEphemeral(h)).toContain(`Captured as lead ${String(lead?.id)}`);

    await h.receiver.dispatch({ ...body, user: { id: 'U0AMAHLE', name: 'amahle', team_id: 'T0TEST' } });
    await h.runtime.queue.onIdle();
    expect(lastEphemeral(h)).toContain('already lead');
    expect(h.runtime.repo.listLeads()).toHaveLength(1);
    expect(h.hubspot.objects.deals.size).toBe(1);
  });

  it('Approve moves the deal stage and updates the card, and a second approve is refused', async () => {
    const lead = await draftLead(h);
    const approved = await click(h, lead, 'approve', 'U0AMAHLE');
    expect(approved).toMatchObject({ status: 'approved', decidedBy: 'U0AMAHLE' });
    expect(h.hubspot.objects.deals.get(lead.dealId ?? '')?.properties.dealstage).toBe('qualifiedtobuy');
    const card = h.slack.messages.find((message) => message.ts === lead.slackTs);
    expect(card?.updates).toBe(1);
    expect(JSON.stringify(card?.blocks)).toContain('Approved by <@U0AMAHLE>');
    expect(JSON.stringify(card?.blocks)).not.toContain(ACTION_IDS.approve);

    await click(h, lead, 'approve', 'U0DANIEL');
    expect(lastEphemeral(h)).toBe(`Lead ${String(lead.id)} was already approved by <@U0AMAHLE>.`);
    await click(h, lead, 'notAFit', 'U0DANIEL');
    expect(h.runtime.repo.getLead(lead.id)?.status).toBe('approved');
  });

  it('Not a fit closes the deal', async () => {
    const lead = await draftLead(h);
    const closed = await click(h, lead, 'notAFit', 'U0DANIEL');
    expect(closed?.status).toBe('not_a_fit');
    expect(h.hubspot.objects.deals.get(lead.dealId ?? '')?.properties.dealstage).toBe('closedlost');
    expect(h.hubspot.objects.deals.get(lead.dealId ?? '')?.properties.hs_is_closed).toBe('true');
  });

  it('Assign to me sets the HubSpot owner by Slack email, and only one person can hold it', async () => {
    const lead = await draftLead(h);
    expect((await click(h, lead, 'assign', 'U0DANIEL'))?.assignedTo).toBe('U0DANIEL');
    expect(h.hubspot.objects.deals.get(lead.dealId ?? '')?.properties.hubspot_owner_id).toBe('7002');
    expect(lastEphemeral(h)).toContain('You are now the deal owner in HubSpot.');
    await click(h, lead, 'assign', 'U0AMAHLE');
    expect(lastEphemeral(h)).toContain('already assigned to <@U0DANIEL>');
    expect(h.runtime.repo.getLead(lead.id)?.assignedTo).toBe('U0DANIEL');
  });

  it('Assign explains when the Slack user has no HubSpot owner', async () => {
    const lead = await draftLead(h);
    await click(h, lead, 'assign', 'U0AMAHLE');
    expect(lastEphemeral(h)).toContain('No HubSpot user has your Slack email address');
  });

  it('approving a reviewed lead creates the records only then, at the approved stage, owned by the assignee', async () => {
    h.setAi(() => ({ kind: 'hang' }));
    const lead = await draftLead(h);
    expect(lead.status).toBe('needs_review');
    expect(h.hubspot.objects.deals.size).toBe(0);
    await click(h, lead, 'assign', 'U0DANIEL');
    expect(lastEphemeral(h)).toContain('created when the lead is approved');
    const approved = await click(h, lead, 'approve', 'U0AMAHLE');
    expect(approved?.status).toBe('approved');
    const deal = h.hubspot.objects.deals.get(approved?.dealId ?? '');
    expect(deal?.properties).toMatchObject({ dealstage: 'qualifiedtobuy', hubspot_owner_id: '7002' });
    expect(h.hubspot.objects.contacts.size).toBe(1);
    expect(h.hubspot.objects.notes.size).toBe(1);
  });

  it('undoes the decision when HubSpot rejects the stage change, so it can be retried', async () => {
    const lead = await draftLead(h);
    h.hubspot.failPath('PATCH', '/crm/v3/objects/deals', 500, 3);
    const failed = await click(h, lead, 'approve', 'U0AMAHLE');
    expect(failed?.status).toBe('drafted');
    expect(lastEphemeral(h)).toContain('HubSpot did not accept the change');
    const retried = await click(h, lead, 'approve', 'U0AMAHLE');
    expect(retried?.status).toBe('approved');
  });

  it('answers clicks on unknown or finished leads politely, and ignores malformed actions', async () => {
    await h.receiver.dispatch(blockAction({ id: 999, slackChannel: 'C0SALES', slackTs: '1.1' }, ACTION_IDS.approve, 'U0AMAHLE'));
    expect(lastEphemeral(h)).toBe('Lead 999 was not found.');
    h.setAi(() => ({ kind: 'extraction', extraction: extraction({ intent: { value: 'spam', confidence: 0.99 } }) }));
    const spam = await draftLead(h);
    await h.receiver.dispatch(blockAction({ ...spam, slackChannel: 'C0SALES', slackTs: '1.1' }, ACTION_IDS.notAFit, 'U0AMAHLE'));
    expect(lastEphemeral(h)).toContain('is spam, so there is nothing to decide');
    const before = h.slack.ephemerals.length;
    await h.receiver.dispatch({ ...blockAction({ id: 1, slackChannel: 'C0SALES', slackTs: '1.1' }, ACTION_IDS.approve, 'U0AMAHLE'), actions: [{ type: 'button', action_id: ACTION_IDS.approve, block_id: 'b', value: 'not-a-number', action_ts: '1' }] });
    expect(h.slack.ephemerals.length).toBe(before);
    await h.receiver.dispatch(blockAction({ id: 999, slackChannel: 'C0SALES', slackTs: '1.1' }, ACTION_IDS.assign, 'U0AMAHLE'));
    expect(lastEphemeral(h)).toBe('Lead 999 was not found.');
  });
});
