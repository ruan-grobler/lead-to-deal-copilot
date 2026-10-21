import {
  collapseWhitespace,
  companyNameFromDomain,
  emailDomain,
  normalizeEmail,
  normalizePhone,
  truncate,
} from '../domain/normalize.ts';
import type { InboundLead } from '../domain/types.ts';
import type { BudgetBand, Intent, LeadExtraction, Urgency } from './schema.ts';

const EMAIL_IN_TEXT = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_IN_TEXT = /(?:\+27|\b0)[\s-]?\(?\d{2}\)?[\s-]?\d{3}[\s-]?\d{4}\b/g;
const AMOUNT_IN_TEXT = /(?:\bR|\bZAR)\s?(\d[\d ,.]*\d|\d)\s*(k|m|mil|million|thousand)?\b/gi;
const MONTHLY_AFTER_AMOUNT = /^\s*(?:\/\s*|per\s+|a\s+|p\/?)?(?:month|mth|mo|pm|monthly)\b/i;

const SPAM_PATTERNS = [
  /\bseo\b/i,
  /\bbacklinks?\b/i,
  /\bguest post/i,
  /\blink building\b/i,
  /\b(crypto|bitcoin|forex|casino|lottery)\b/i,
  /\byou have won\b/i,
  /\bverify your (password|account|mailbox)\b/i,
  /\bmailbox (is )?(full|almost full)\b/i,
  /\bpage (1|one) of google\b/i,
  /\binvestment opportunity\b/i,
];
const SUPPORT_PATTERNS = [
  /\bticket\b/i,
  /\bnot working\b/i,
  /\b(is|are|went) (down|offline)\b/i,
  /\boffline again\b/i,
  /\bcan'?t (log ?in|sign in|access|connect)\b/i,
  /\bpassword reset\b/i,
  /\bexisting (client|customer)\b/i,
  /\bour (support )?contract\b/i,
  /\bhelp ?desk\b/i,
];
const HIGH_URGENCY = /\b(urgent(ly)?|asap|immediately|right away|today|tomorrow|this week|next week|within (a|one|1|two|2) weeks?|in (two|2) weeks|outage|ransomware|breach|hacked|deadline|by (monday|tuesday|wednesday|thursday|friday))\b/i;
const MEDIUM_URGENCY = /\b(this month|next month|this quarter|next quarter|q[1-4]|soon|in a few weeks|within (a|one|1|two|2|three|3) months?)\b/i;
const LOW_URGENCY = /\b(exploring|researching|just looking|next year|no rush|budgeting|early stages?)\b/i;
const SIGN_OFF = /^(kind regards|best regards|warm regards|regards|thanks|thank you|many thanks|cheers|best)[,!.]?$/i;
const PERSON_NAME = /^[A-Z][a-zA-Z'-]+(?:\s+(?:van|der|de|du|le)?\s*[A-Z][a-zA-Z'-]+){0,3}$/;

const field = <T>(value: T | null, confidence: number): { value: T | null; confidence: number } => ({
  value,
  confidence: value === null ? 0 : confidence,
});

const parseAmount = (digits: string, unit: string | undefined): number | null => {
  let cleaned = digits.replace(/\s/g, '');
  if (/^\d{1,3}(,\d{3})+$/.test(cleaned)) {
    cleaned = cleaned.replace(/,/g, '');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(cleaned) && !unit) {
    cleaned = cleaned.replace(/\./g, '');
  } else {
    cleaned = cleaned.replace(/,/g, '.');
  }
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) {
    return null;
  }
  const lowerUnit = unit?.toLowerCase();
  if (lowerUnit === 'k' || lowerUnit === 'thousand') {
    return value * 1_000;
  }
  if (lowerUnit === 'm' || lowerUnit === 'mil' || lowerUnit === 'million') {
    return value * 1_000_000;
  }
  return value;
};

/** The largest rand amount in the text, annualised when it reads as monthly. */
export const findAnnualBudgetZar = (text: string): number | null => {
  let best: number | null = null;
  for (const match of text.matchAll(AMOUNT_IN_TEXT)) {
    const amount = parseAmount(match[1] ?? '', match[2]);
    if (amount === null) {
      continue;
    }
    const end = match.index + match[0].length;
    const after = text.slice(end, end + 20);
    const annual = MONTHLY_AFTER_AMOUNT.test(after) ? amount * 12 : amount;
    best = best === null ? annual : Math.max(best, annual);
  }
  return best;
};

export const budgetBandFor = (annualZar: number | null): BudgetBand => {
  if (annualZar === null) {
    return 'unknown';
  }
  if (annualZar < 50_000) {
    return 'under_50k';
  }
  if (annualZar < 300_000) {
    return '50k_to_300k';
  }
  if (annualZar < 1_000_000) {
    return '300k_to_1m';
  }
  return 'over_1m';
};

export const detectUrgency = (text: string): Urgency => {
  if (HIGH_URGENCY.test(text)) {
    return 'high';
  }
  if (MEDIUM_URGENCY.test(text)) {
    return 'medium';
  }
  if (LOW_URGENCY.test(text)) {
    return 'low';
  }
  return 'unknown';
};

const looksLikeJunk = (text: string): boolean => {
  const compact = collapseWhitespace(text);
  if (compact.length < 12) {
    return true;
  }
  return /^(test|testing|asdf|qwerty)\b/i.test(compact) && compact.length < 40;
};

export const detectIntent = (text: string): { value: Intent; confidence: number } => {
  if (looksLikeJunk(text) || SPAM_PATTERNS.some((pattern) => pattern.test(text))) {
    return { value: 'spam', confidence: 0.6 };
  }
  if (SUPPORT_PATTERNS.some((pattern) => pattern.test(text))) {
    return { value: 'support', confidence: 0.6 };
  }
  return { value: 'sales_lead', confidence: 0.4 };
};

export const nameFromSignature = (text: string): string | null => {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  for (let index = 0; index < lines.length; index += 1) {
    if (SIGN_OFF.test(lines[index] ?? '')) {
      const next = lines.slice(index + 1).find((line) => line.length > 0);
      if (next && PERSON_NAME.test(next)) {
        return next;
      }
    }
  }
  const last = [...lines].reverse().find((line) => line.length > 0) ?? '';
  const dashed = /^[-~]\s*([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)?)$/.exec(last);
  return dashed?.[1] ?? null;
};

const firstSentence = (text: string): string | null => {
  const compact = collapseWhitespace(text);
  if (!compact) {
    return null;
  }
  const end = compact.search(/[.!?](\s|$)/);
  return truncate(end > 0 ? compact.slice(0, end + 1) : compact, 160);
};

/**
 * Deterministic extraction used when Claude is unavailable, slow, invalid or
 * unsure. It is deliberately conservative: its output always goes to a human.
 */
export const extractWithRules = (lead: InboundLead): LeadExtraction => {
  const haystack = [lead.subject ?? '', lead.text].join('\n');

  const hintEmail = normalizeEmail(lead.hints.email);
  const textEmail = [...haystack.matchAll(EMAIL_IN_TEXT)].map((match) => normalizeEmail(match[0])).find((email) => email !== null) ?? null;
  const email = hintEmail ?? textEmail;

  const hintPhone = normalizePhone(lead.hints.phone);
  const textPhone = [...haystack.matchAll(PHONE_IN_TEXT)].map((match) => normalizePhone(match[0])).find((phone) => phone !== null) ?? null;

  const signatureName = nameFromSignature(lead.text);
  const domain = email ? emailDomain(email) : null;
  const domainCompany = domain && domain !== 'example.com' ? companyNameFromDomain(domain) : null;

  const annual = findAnnualBudgetZar(haystack);
  const urgency = detectUrgency(haystack);
  const intent = detectIntent(lead.text);
  const need = lead.subject ? truncate(collapseWhitespace(lead.subject), 160) : firstSentence(lead.text);
  const who = lead.hints.company ?? domainCompany ?? lead.hints.name ?? signatureName ?? 'Unknown sender';

  return {
    name: lead.hints.name ? field(lead.hints.name, 0.9) : field(signatureName, 0.5),
    company: lead.hints.company ? field(lead.hints.company, 0.9) : field(domainCompany, 0.4),
    email: hintEmail ? field(hintEmail, 0.95) : field(textEmail, 0.8),
    phone: hintPhone ? field(hintPhone, 0.9) : field(textPhone, 0.75),
    need: field(need, 0.4),
    budgetBand: { value: budgetBandFor(annual), confidence: annual === null ? 0.3 : 0.6 },
    urgency: { value: urgency, confidence: urgency === 'unknown' ? 0.3 : 0.5 },
    intent,
    summary: truncate(`${who}: ${need ?? 'no message text'}`, 140),
  };
};
