import type { InboundLead } from '../domain/types.ts';
import { slackIdempotencyKey } from '../reliability/idempotency.ts';

export interface SlackMessageInput {
  teamId: string;
  channelId: string;
  messageTs: string;
  text: string;
  authorUserId: string | null;
  sharedByUserId: string;
}

/**
 * A message someone flagged with the "Create lead from message" shortcut.
 * The author is usually a salesperson pasting lead details, not the lead, so
 * the author is kept as metadata rather than used as the contact.
 */
export const slackMessageToLead = (input: SlackMessageInput, receivedAt: Date): InboundLead => {
  const meta: Record<string, string> = {
    teamId: input.teamId,
    channelId: input.channelId,
    messageTs: input.messageTs,
    sharedBy: input.sharedByUserId,
  };
  if (input.authorUserId) {
    meta.author = input.authorUserId;
  }
  const text = input.text.trim();
  return {
    source: 'slack',
    idempotencyKey: slackIdempotencyKey(input.teamId, input.channelId, input.messageTs),
    receivedAt: receivedAt.toISOString(),
    subject: null,
    text,
    hints: {},
    meta,
    parseWarnings: text.length === 0 ? ['empty_body'] : [],
  };
};
