import type { ActionsBlock, ContextBlock, KnownBlock, SectionBlock } from '@slack/types';
import type { LeadRow } from '../db/repository.ts';
import { formatPhone, truncate } from '../domain/normalize.ts';
import type { ExtractionField } from '../extraction/schema.ts';
import { BUDGET_LABELS, FALLBACK_LABELS, INTENT_LABELS, SOURCE_LABELS, URGENCY_LABELS } from '../pipeline/labels.ts';
import { formatDuration } from '../scheduler/time.ts';

export const ACTION_IDS = {
  approve: 'lead_approve',
  assign: 'lead_assign',
  notAFit: 'lead_not_a_fit',
} as const;

export const SHORTCUT_CALLBACK_ID = 'create_lead_from_message';

export interface SlackMessage {
  text: string;
  blocks: KnownBlock[];
}

export interface CardContext {
  dealUrl: (dealId: string) => string | null;
  salesLeadUserId: string | null;
  stageLabels: { approved: string; notAFit: string };
}

export interface DigestView {
  dateLabel: string;
  received: number;
  autoDrafted: number;
  needsReview: number;
  approved: number;
  notAFit: number;
  merged: number;
  spam: number;
  support: number;
  duplicatesBlocked: number;
  deadLettersPending: number;
  waitingTotal: number;
  /** The oldest few, for display. */
  waiting: { leadId: number; title: string; ageMinutes: number; status: string }[];
}

export interface DeadLetterAlert {
  leadId: number;
  deadLetterId: number;
  stage: string;
  attempts: number;
  status: string;
}

/** Slack mrkdwn treats &, < and > as control characters. User text must never form mentions or links. */
export const escapeMrkdwn = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const plain = (text: string): { type: 'plain_text'; text: string; emoji: boolean } => ({ type: 'plain_text', text, emoji: true });

const section = (text: string): SectionBlock => ({ type: 'section', text: { type: 'mrkdwn', text: truncate(text, 3000) } });

const context = (text: string): ContextBlock => ({ type: 'context', elements: [{ type: 'mrkdwn', text: truncate(text, 3000) }] });

export const leadTitle = (lead: LeadRow): string => {
  const extraction = lead.decision?.extraction;
  return extraction?.company.value ?? extraction?.name.value ?? extraction?.email.value ?? lead.inbound.hints.email ?? 'Unknown sender';
};

const actionsFor = (lead: LeadRow): ActionsBlock => ({
  type: 'actions',
  block_id: `lead_actions_${String(lead.id)}`,
  elements: [
    {
      type: 'button',
      action_id: ACTION_IDS.approve,
      text: plain(lead.route === 'human_review' ? 'Approve and create deal' : 'Approve'),
      style: 'primary',
      value: String(lead.id),
    },
    { type: 'button', action_id: ACTION_IDS.assign, text: plain('Assign to me'), value: String(lead.id) },
    {
      type: 'button',
      action_id: ACTION_IDS.notAFit,
      text: plain('Not a fit'),
      style: 'danger',
      value: String(lead.id),
      confirm: {
        title: plain('Mark as not a fit?'),
        text: plain('The lead is closed and the deal, if there is one, moves to Closed lost.'),
        confirm: plain('Not a fit'),
        deny: plain('Cancel'),
        style: 'danger',
      },
    },
  ],
});

const statusLine = (lead: LeadRow, ctx: CardContext): string | null => {
  const parts: string[] = [];
  if (lead.status === 'approved' && lead.decidedBy) {
    const where = lead.mergedIntoDealId ? `Merged into open deal ${lead.mergedIntoDealId}.` : `Deal is now in ${ctx.stageLabels.approved}.`;
    parts.push(`Approved by <@${lead.decidedBy}>. ${where}`);
  }
  if (lead.status === 'not_a_fit' && lead.decidedBy) {
    parts.push(`Marked not a fit by <@${lead.decidedBy}>.${lead.dealId ? ` Deal moved to ${ctx.stageLabels.notAFit}.` : ''}`);
  }
  if (lead.assignedTo) {
    parts.push(`Assigned to <@${lead.assignedTo}>.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
};

/** The card a salesperson acts on. Rebuilt from the database row, so updates always show the current state. */
export const leadCard = (lead: LeadRow, ctx: CardContext): SlackMessage => {
  const decision = lead.decision;
  if (!decision) {
    throw new Error(`Lead ${String(lead.id)} has no extraction yet`);
  }
  const x = decision.extraction;
  const review = lead.route === 'human_review';
  const title = leadTitle(lead);
  const heading = review ? `Needs review: ${title}` : lead.priority ? `High value lead: ${title}` : `New lead: ${title}`;
  const low = new Set<ExtractionField>(decision.lowConfidenceFields);
  const value = (key: ExtractionField, text: string | null): string =>
    `${text === null ? '_not found_' : escapeMrkdwn(text)}${low.has(key) ? ' _(low confidence)_' : ''}`;

  const blocks: KnownBlock[] = [{ type: 'header', text: plain(truncate(heading, 150)) }];

  if (review) {
    const reasons = [
      decision.fallbackReason ? FALLBACK_LABELS[decision.fallbackReason] : null,
      ...lead.inbound.parseWarnings.map((warning) => `the message had a problem (${warning.replace(/_/g, ' ')})`),
    ].filter((reason): reason is string => reason !== null);
    const why = reasons.length > 0 ? reasons.join(', and ') : 'it did not meet the auto draft rules';
    const fieldsFrom = decision.method === 'rules' ? ' The fields below came from fallback rules, so check them.' : '';
    const onApprove =
      x.email.value === null
        ? 'There is no valid email, so approving creates a contact without one and no duplicate check is possible.'
        : 'Approving checks HubSpot for the contact and company, then creates the deal.';
    blocks.push(section(`:warning: Sent to review because ${why}.${fieldsFrom} ${onApprove}`));
  }
  if (lead.priority) {
    const mention = ctx.salesLeadUserId ? `<@${ctx.salesLeadUserId}> ` : '';
    blocks.push(section(`:rotating_light: ${mention}High value: budget ${BUDGET_LABELS[x.budgetBand.value]}, urgency ${URGENCY_LABELS[x.urgency.value]}.`));
  }

  blocks.push(section(escapeMrkdwn(x.summary)));

  const dealUrl = lead.dealId ? ctx.dealUrl(lead.dealId) : null;
  const deal = lead.dealId ? (dealUrl ? `<${dealUrl}|Deal ${lead.dealId}>` : `Deal ${lead.dealId}`) : review ? 'Created on approval' : 'Not created';
  blocks.push({
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*Name*\n${value('name', x.name.value)}` },
      { type: 'mrkdwn', text: `*Email*\n${value('email', x.email.value)}` },
      { type: 'mrkdwn', text: `*Phone*\n${value('phone', x.phone.value ? formatPhone(x.phone.value) : null)}` },
      { type: 'mrkdwn', text: `*Budget*\n${value('budgetBand', BUDGET_LABELS[x.budgetBand.value])}` },
      { type: 'mrkdwn', text: `*Urgency*\n${value('urgency', URGENCY_LABELS[x.urgency.value])}` },
      { type: 'mrkdwn', text: `*HubSpot*\n${deal}` },
    ],
  });

  const method = decision.method === 'ai' ? 'Extracted by Claude' : 'Extracted by fallback rules';
  const dedupe =
    lead.dedupeMatch === 'contact_email' ? ' Existing contact matched by email.' : lead.dedupeMatch === 'company_domain' ? ' Existing company matched by domain.' : '';
  blocks.push(
    context(
      `${method}, ${INTENT_LABELS[x.intent.value].toLowerCase()} ${x.intent.confidence.toFixed(2)}. From ${SOURCE_LABELS[lead.source]}. Lead ${String(lead.id)}.${dedupe}`,
    ),
  );

  const status = statusLine(lead, ctx);
  const decided = lead.status === 'approved' || lead.status === 'not_a_fit';
  if (status) {
    blocks.push(context(status));
  }
  if (!decided) {
    blocks.push(actionsFor(lead));
  }
  return { text: `${heading}. ${truncate(x.summary, 200)}`, blocks };
};

export const mergeNotice = (lead: LeadRow): SlackMessage => {
  const matchedBy = lead.dedupeMatch === 'company_domain' ? 'company domain' : 'email address';
  const text = `Duplicate caught: a new message from ${escapeMrkdwn(leadTitle(lead))} (${SOURCE_LABELS[lead.source]}) matched an open deal by ${matchedBy}. It was added to deal ${lead.dealId ?? ''} as a note, and no new deal was created. Lead ${String(lead.id)}.`;
  return { text, blocks: [section(`:link: ${text}`)] };
};

export const supportNotice = (lead: LeadRow): SlackMessage => {
  const summary = lead.decision?.extraction.summary ?? lead.inbound.text;
  const text = `Support request from ${escapeMrkdwn(leadTitle(lead))}: ${escapeMrkdwn(truncate(summary, 300))}`;
  return {
    text,
    blocks: [section(`:wrench: ${text}`), context(`Not a sales lead, so no deal was created. Lead ${String(lead.id)}, via ${SOURCE_LABELS[lead.source]}.`)],
  };
};

export const reminderMessage = (lead: LeadRow, ageMinutes: number, salesLeadUserId: string | null): SlackMessage => {
  const mention = salesLeadUserId ? ` <@${salesLeadUserId}>` : '';
  const text = `Lead ${String(lead.id)} (${escapeMrkdwn(leadTitle(lead))}) has waited ${formatDuration(ageMinutes)} and nobody has picked it up.${mention} Approve it, assign it or mark it not a fit.`;
  return { text, blocks: [section(`:alarm_clock: ${text}`)] };
};

export const digestMessage = (view: DigestView): SlackMessage => {
  const heading = `Lead digest for ${view.dateLabel}`;
  const more = view.waitingTotal - view.waiting.length;
  const waiting =
    view.waitingTotal === 0
      ? 'Nothing is waiting for a decision.'
      : [
          ...view.waiting.map((item) => `- Lead ${String(item.leadId)}, ${escapeMrkdwn(item.title)}: waiting ${formatDuration(item.ageMinutes)} (${item.status.replace('_', ' ')})`),
          ...(more > 0 ? [`- and ${String(more)} more`] : []),
        ].join('\n');
  const blocks: KnownBlock[] = [
    { type: 'header', text: plain(heading) },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Received*\n${String(view.received)}` },
        { type: 'mrkdwn', text: `*Auto drafted*\n${String(view.autoDrafted)}` },
        { type: 'mrkdwn', text: `*Needed review*\n${String(view.needsReview)}` },
        { type: 'mrkdwn', text: `*Approved*\n${String(view.approved)}` },
        { type: 'mrkdwn', text: `*Not a fit*\n${String(view.notAFit)}` },
        { type: 'mrkdwn', text: `*Merged into open deals*\n${String(view.merged)}` },
        { type: 'mrkdwn', text: `*Spam filtered*\n${String(view.spam)}` },
        { type: 'mrkdwn', text: `*Support routed*\n${String(view.support)}` },
        { type: 'mrkdwn', text: `*Replays blocked*\n${String(view.duplicatesBlocked)}` },
        { type: 'mrkdwn', text: `*Dead letters pending*\n${String(view.deadLettersPending)}` },
      ],
    },
    section(`*Waiting for action (${String(view.waitingTotal)})*\n${waiting}`),
  ];
  const text = `${heading}: ${String(view.received)} received, ${String(view.autoDrafted)} auto drafted, ${String(view.needsReview)} needed review, ${String(view.waitingTotal)} waiting for a decision.`;
  return { text, blocks };
};

export const deadLetterAlertMessage = (alert: DeadLetterAlert): SlackMessage => {
  const text = `Lead ${String(alert.leadId)} failed at ${alert.stage} after ${String(alert.attempts)} attempt${alert.attempts === 1 ? '' : 's'} (${alert.status}) and is in the dead letter table as entry ${String(alert.deadLetterId)}. Nothing is lost. Fix the cause, then run: npm run replay`;
  return { text, blocks: [section(`:rotating_light: ${escapeMrkdwn(text)}`)] };
};
