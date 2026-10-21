import { createHash } from 'node:crypto';

export const sha256 = (input: string | Uint8Array): string => createHash('sha256').update(input).digest('hex');

/** JSON with sorted keys, so the same payload always hashes the same way. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

/** A form provider's submission id survives its own retries. Without one, hash the payload. */
export const formIdempotencyKey = (payload: { submissionId?: string | undefined } & Record<string, unknown>): string => {
  const submissionId = payload.submissionId?.trim();
  if (submissionId) {
    return `form:${submissionId}`;
  }
  return `form:sha256:${sha256(canonicalJson(payload)).slice(0, 32)}`;
};

export const normalizeMessageId = (messageId: string | null | undefined): string | null => {
  if (!messageId) {
    return null;
  }
  const cleaned = messageId.trim().replace(/^<|>$/g, '').trim().toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
};

/** Mail providers redeliver with the same Message-ID. Without one, hash the raw message. */
export const emailIdempotencyKey = (messageId: string | null | undefined, raw: string | Uint8Array): string => {
  const normalized = normalizeMessageId(messageId);
  return normalized ? `email:${normalized}` : `email:sha256:${sha256(raw).slice(0, 32)}`;
};

/** A Slack message is unique by workspace, channel and timestamp. */
export const slackIdempotencyKey = (teamId: string, channelId: string, messageTs: string): string => `slack:${teamId}:${channelId}:${messageTs}`;
