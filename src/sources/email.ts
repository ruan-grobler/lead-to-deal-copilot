import PostalMime from 'postal-mime';
import { normalizeEmail } from '../domain/normalize.ts';
import type { InboundLead, LeadHints } from '../domain/types.ts';
import { emailIdempotencyKey } from '../reliability/idempotency.ts';

type ParsedEmail = Awaited<ReturnType<typeof PostalMime.parse>>;
type Address = NonNullable<ParsedEmail['from']>;

const firstMailbox = (address: Address | undefined): { name: string; address: string } | null => {
  if (!address) {
    return null;
  }
  if (address.address !== undefined) {
    return { name: address.name, address: address.address };
  }
  const member = address.group[0];
  return member ? { name: member.name, address: member.address } : null;
};

const htmlToText = (html: string): string =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();

/** Drops quoted history ("On ... wrote:" and lines starting with ">") so only the new message is analysed. */
export const stripQuotedReply = (body: string): string => {
  const lines = body.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    if (/^On .+wrote:\s*$/i.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}$/i.test(line.trim())) {
      break;
    }
    if (!line.trimStart().startsWith('>')) {
      kept.push(line);
    }
  }
  return kept.join('\n').trim();
};

/** Body text of a message that MIME parsing could not handle: everything after the first blank line. */
const rawBodyFallback = (raw: string): string => {
  const split = raw.split(/\r?\n\r?\n/);
  return split.slice(1).join('\n\n').trim() || raw.trim();
};

/**
 * Parses an RFC 822 message into a lead. It never throws on bad input: a
 * malformed message becomes a lead with parse warnings, which routes it to
 * human review instead of losing it.
 */
export const parseEmailToLead = async (raw: string | Uint8Array, receivedAt: Date): Promise<InboundLead> => {
  const rawText = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  const parseWarnings: string[] = [];
  let parsed: ParsedEmail | null = null;
  try {
    parsed = await PostalMime.parse(rawText);
  } catch {
    parseWarnings.push('unparseable_mime');
  }

  const from = firstMailbox(parsed?.from);
  const replyTo = firstMailbox(parsed?.replyTo?.[0]);
  const fromEmail = normalizeEmail(from?.address);
  const replyToEmail = normalizeEmail(replyTo?.address);
  if (parsed && !from) {
    parseWarnings.push('missing_from');
  } else if (from && !fromEmail) {
    parseWarnings.push('invalid_from_address');
  }

  const bodySource = parsed?.text?.trim() || (parsed?.html ? htmlToText(parsed.html) : '') || (parsed ? '' : rawBodyFallback(rawText));
  const body = stripQuotedReply(bodySource);
  if (!body) {
    parseWarnings.push('empty_body');
  }

  const hints: LeadHints = {};
  const contactEmail = replyToEmail ?? fromEmail;
  if (contactEmail) {
    hints.email = contactEmail;
  }
  const displayName = (replyToEmail ? replyTo?.name : from?.name)?.trim();
  if (displayName && !displayName.includes('@')) {
    hints.name = displayName;
  }

  const meta: Record<string, string> = {};
  if (parsed?.messageId) {
    meta.messageId = parsed.messageId;
  }
  if (from?.address && !fromEmail) {
    meta.rawFrom = from.address.slice(0, 320);
  }
  if (parsed?.date) {
    meta.sentAt = parsed.date;
  }

  return {
    source: 'email',
    idempotencyKey: emailIdempotencyKey(parsed?.messageId, rawText),
    receivedAt: receivedAt.toISOString(),
    subject: parsed?.subject?.trim() ?? null,
    text: body || rawText.slice(0, 5_000),
    hints,
    meta,
    parseWarnings,
  };
};
