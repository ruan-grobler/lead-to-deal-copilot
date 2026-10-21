import { describe, expect, it } from 'vitest';
import type { LeadRow } from '../../src/db/repository.ts';
import {
  ACTION_IDS,
  deadLetterAlertMessage,
  digestMessage,
  escapeMrkdwn,
  leadCard,
  mergeNotice,
  reminderMessage,
  supportNotice,
  type CardContext,
} from '../../src/slack/blocks.ts';
import { extraction } from '../helpers/harness.ts';

const ctx: CardContext = {
  dealUrl: (dealId) => `https://app.hubspot.com/contacts/123/record/0-3/${dealId}`,
  salesLeadUserId: 'U0LEAD',
  stageLabels: { approved: 'Qualified to buy', notAFit: 'Closed lost' },
};

const row = (overrides: Partial<LeadRow> = {}): LeadRow => ({
  id: 7,
  idempotencyKey: 'form:7',
  source: 'form',
  status: 'drafted',
  route: 'auto_draft',
  priority: false,
  inbound: { source: 'form', idempotencyKey: 'form:7', receivedAt: '2026-10-20T07:00:00.000Z', subject: null, text: 'hello', hints: {}, meta: {}, parseWarnings: [] },
  decision: { extraction: extraction({ phone: ['+27000000001', 0.95] }), method: 'ai', fallbackReason: null, fallbackDetail: null, lowConfidenceFields: [], aiLatencyMs: 10 },
  contactId: '1001',
  companyId: '2001',
  dealId: '3001',
  noteId: '4001',
  dedupeMatch: 'none',
  mergedIntoDealId: null,
  slackChannel: 'C0SALES',
  slackTs: '1.1',
  cardPostedAt: '2026-10-20T07:00:01.000Z',
  decidedBy: null,
  decidedAt: null,
  assignedTo: null,
  assignedAt: null,
  remindedAt: null,
  attempts: 1,
  duplicateHits: 0,
  receivedAt: '2026-10-20T07:00:00.000Z',
  updatedAt: '2026-10-20T07:00:01.000Z',
  completedAt: '2026-10-20T07:00:01.000Z',
  latencyMs: 12,
  ...overrides,
});

const allText = (blocks: unknown[]): string => JSON.stringify(blocks);

describe('lead card', () => {
  it('shows the extracted fields, a deal link and three buttons', () => {
    const card = leadCard(row(), ctx);
    expect(card.text).toContain('New lead: Test Company');
    expect(card.blocks[0]).toMatchObject({ type: 'header' });
    const text = allText(card.blocks);
    expect(text).toContain('+27 00 000 0001');
    expect(text).toContain('<https://app.hubspot.com/contacts/123/record/0-3/3001|Deal 3001>');
    const actions = card.blocks.find((block) => block.type === 'actions');
    expect(actions && 'elements' in actions ? actions.elements.map((element) => ('action_id' in element ? element.action_id : null)) : []).toEqual([
      ACTION_IDS.approve,
      ACTION_IDS.assign,
      ACTION_IDS.notAFit,
    ]);
  });

  it('marks priority leads and mentions the sales lead', () => {
    const text = allText(leadCard(row({ priority: true }), ctx).blocks);
    expect(text).toContain('High value lead');
    expect(text).toContain('<@U0LEAD>');
  });

  it('explains why a lead needs review and flags low confidence fields', () => {
    const card = leadCard(
      row({
        route: 'human_review',
        status: 'needs_review',
        dealId: null,
        decision: { extraction: extraction({ email: [null, 0], name: ['Sam', 0.4] }), method: 'rules', fallbackReason: 'timeout', fallbackDetail: null, lowConfidenceFields: ['name'], aiLatencyMs: null },
        inbound: { ...row().inbound, parseWarnings: ['invalid_from_address'] },
      }),
      ctx,
    );
    const text = allText(card.blocks);
    expect(card.text).toContain('Needs review');
    expect(text).toContain('the AI call timed out');
    expect(text).toContain('invalid from address');
    expect(text).toContain('fallback rules');
    expect(text).toContain('no duplicate check is possible');
    expect(text).toContain('(low confidence)');
    expect(text).toContain('Approve and create deal');
    expect(text).toContain('Created on approval');
  });

  it('replaces the buttons with the decision once someone acts', () => {
    const approved = allText(leadCard(row({ status: 'approved', decidedBy: 'U1', assignedTo: 'U2' }), ctx).blocks);
    expect(approved).toContain('Approved by <@U1>. Deal is now in Qualified to buy.');
    expect(approved).toContain('Assigned to <@U2>.');
    expect(approved).not.toContain(ACTION_IDS.approve);
    const notAFit = allText(leadCard(row({ status: 'not_a_fit', decidedBy: 'U3' }), ctx).blocks);
    expect(notAFit).toContain('Marked not a fit by <@U3>. Deal moved to Closed lost.');
    const mergedApproval = allText(leadCard(row({ status: 'approved', decidedBy: 'U1', mergedIntoDealId: '3001' }), ctx).blocks);
    expect(mergedApproval).toContain('Merged into open deal 3001.');
  });

  it('never lets lead text create mentions or links', () => {
    const hostile = extraction({ company: ['<!channel> Evil & Co', 0.9] });
    const card = leadCard(row({ decision: { extraction: { ...hostile, summary: '<https://phish.example.com|click> <@U123>' }, method: 'ai', fallbackReason: null, fallbackDetail: null, lowConfidenceFields: [], aiLatencyMs: 1 } }), ctx);
    const text = allText(card.blocks.slice(1));
    expect(text).not.toContain('<!channel>');
    expect(text).not.toContain('<https://phish');
    expect(text).toContain('&lt;https://phish.example.com|click&gt;');
    expect(escapeMrkdwn('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('refuses to render a lead without an extraction', () => {
    expect(() => leadCard(row({ decision: null }), ctx)).toThrow('no extraction');
  });

  it('shows a plain deal number without a portal id', () => {
    expect(allText(leadCard(row(), { ...ctx, dealUrl: () => null }).blocks)).toContain('Deal 3001');
  });
});

describe('other messages', () => {
  it('builds merge, support, reminder, digest and alert messages', () => {
    expect(mergeNotice(row({ dedupeMatch: 'company_domain', mergedIntoDealId: '3001' })).text).toContain('matched an open deal by company domain');
    expect(mergeNotice(row({ dedupeMatch: 'contact_email' })).text).toContain('by email address');
    expect(supportNotice(row()).text).toContain('Support request from Test Company');
    expect(reminderMessage(row(), 125, 'U0LEAD').text).toBe(
      'Lead 7 (Test Company) has waited 2 h 5 min and nobody has picked it up. <@U0LEAD> Approve it, assign it or mark it not a fit.',
    );
    expect(reminderMessage(row(), 30, null).text).not.toContain('<@');

    const digest = digestMessage({
      dateLabel: 'Wed 21 Oct 2026',
      received: 22,
      autoDrafted: 10,
      needsReview: 5,
      approved: 5,
      notAFit: 1,
      merged: 2,
      spam: 4,
      support: 1,
      duplicatesBlocked: 3,
      deadLettersPending: 0,
      waitingTotal: 9,
      waiting: [{ leadId: 4, title: 'Silvertree', ageMinutes: 90, status: 'needs_review' }],
    });
    expect(digest.text).toBe('Lead digest for Wed 21 Oct 2026: 22 received, 10 auto drafted, 5 needed review, 9 waiting for a decision.');
    expect(allText(digest.blocks)).toContain('and 8 more');
    expect(allText(digest.blocks)).toContain('Lead 4, Silvertree: waiting 1 h 30 min (needs review)');
    const empty = digestMessage({ dateLabel: 'x', received: 0, autoDrafted: 0, needsReview: 0, approved: 0, notAFit: 0, merged: 0, spam: 0, support: 0, duplicatesBlocked: 0, deadLettersPending: 0, waitingTotal: 0, waiting: [] });
    expect(allText(empty.blocks)).toContain('Nothing is waiting for a decision.');

    const alert = deadLetterAlertMessage({ leadId: 22, deadLetterId: 1, stage: 'hubspot.contacts.search', attempts: 5, status: 'HTTP 429' });
    expect(alert.text).toContain('npm run replay');
    expect(alert.text).toContain('after 5 attempts (HTTP 429)');
    expect(deadLetterAlertMessage({ leadId: 1, deadLetterId: 2, stage: 's', attempts: 1, status: 'network' }).text).toContain('after 1 attempt (network)');
  });
});
