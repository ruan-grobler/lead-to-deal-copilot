import type { WebClient } from '@slack/web-api';
import type { LeadRow } from '../db/repository.ts';
import type { RetryRunner } from '../reliability/retry.ts';
import {
  deadLetterAlertMessage,
  digestMessage,
  leadCard,
  mergeNotice,
  reminderMessage,
  supportNotice,
  type CardContext,
  type DeadLetterAlert,
  type DigestView,
  type SlackMessage,
} from './blocks.ts';

export interface PostedMessage {
  channel: string;
  ts: string;
}

export interface SlackNotifier {
  postLeadCard: (lead: LeadRow) => Promise<PostedMessage>;
  /** Re-renders the card from the current row, for example after Approve. */
  updateLeadCard: (lead: LeadRow) => Promise<void>;
  postMergeNotice: (lead: LeadRow, original: LeadRow | null) => Promise<PostedMessage>;
  postSupportNotice: (lead: LeadRow) => Promise<PostedMessage>;
  postReminder: (lead: LeadRow, ageMinutes: number) => Promise<PostedMessage>;
  postDigest: (view: DigestView) => Promise<PostedMessage>;
  postAlert: (alert: DeadLetterAlert) => Promise<PostedMessage>;
  postEphemeral: (channel: string, user: string, text: string) => Promise<void>;
  getUserEmail: (userId: string) => Promise<string | null>;
}

export interface SlackNotifierDeps {
  client: WebClient;
  retry: RetryRunner;
  card: CardContext;
  channels: { sales: string; support: string; alerts: string };
  salesLeadUserId: string | null;
}

export const createSlackNotifier = (deps: SlackNotifierDeps): SlackNotifier => {
  const post = async (channel: string, message: SlackMessage, threadTs?: string): Promise<PostedMessage> => {
    const result = await deps.retry.run('slack.chat.postMessage', async () =>
      deps.client.chat.postMessage({
        channel,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
        unfurl_media: false,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
    );
    if (!result.ts || !result.channel) {
      throw new Error('Slack accepted the message but returned no ts or channel');
    }
    return { channel: result.channel, ts: result.ts };
  };

  return {
    postLeadCard: async (lead) => post(deps.channels.sales, leadCard(lead, deps.card)),

    updateLeadCard: async (lead) => {
      if (!lead.slackChannel || !lead.slackTs) {
        return;
      }
      const message = leadCard(lead, deps.card);
      const channel = lead.slackChannel;
      const ts = lead.slackTs;
      await deps.retry.run('slack.chat.update', async () => deps.client.chat.update({ channel, ts, text: message.text, blocks: message.blocks }));
    },

    postMergeNotice: async (lead, original) => {
      const message = mergeNotice(lead);
      if (original?.slackChannel && original.slackTs) {
        return post(original.slackChannel, message, original.slackTs);
      }
      return post(deps.channels.sales, message);
    },

    postSupportNotice: async (lead) => post(deps.channels.support, supportNotice(lead)),

    postReminder: async (lead, ageMinutes) => {
      if (!lead.slackChannel || !lead.slackTs) {
        throw new Error(`Lead ${String(lead.id)} has no Slack card to remind on`);
      }
      return post(lead.slackChannel, reminderMessage(lead, ageMinutes, deps.salesLeadUserId), lead.slackTs);
    },

    postDigest: async (view) => post(deps.channels.sales, digestMessage(view)),

    postAlert: async (alert) => post(deps.channels.alerts, deadLetterAlertMessage(alert)),

    postEphemeral: async (channel, user, text) => {
      await deps.retry.run('slack.chat.postEphemeral', async () => deps.client.chat.postEphemeral({ channel, user, text }));
    },

    getUserEmail: async (userId) => {
      const result = await deps.retry.run('slack.users.info', async () => deps.client.users.info({ user: userId }));
      return result.user?.profile?.email ?? null;
    },
  };
};
