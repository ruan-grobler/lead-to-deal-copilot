import { normalizeEmail, normalizePhone } from '../domain/normalize.ts';
import type { ExtractionDecision, FallbackReason, InboundLead } from '../domain/types.ts';
import type { Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import type { AiExtractor } from './claude.ts';
import { extractWithRules } from './rules.ts';
import { EXTRACTION_FIELDS, type ExtractionField, type LeadExtraction } from './schema.ts';

export interface LeadExtractor {
  extract: (lead: InboundLead) => Promise<ExtractionDecision>;
}

export interface LeadExtractorDeps {
  ai: AiExtractor | null;
  minConfidence: number;
  logger: Logger;
  metrics: Metrics;
}

const digitsOnly = (value: string): string => value.replace(/\D/g, '');

/** Everything the lead actually contains. Contact details from the model must appear in here. */
const groundingText = (lead: InboundLead): string => {
  const { name, email, company, phone, website } = lead.hints;
  return [lead.subject, lead.text, name, email, company, phone, website, ...Object.values(lead.meta)]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .toLowerCase();
};

/** Form fields and email headers are authoritative for who sent the lead. */
const applyHints = (extraction: LeadExtraction, lead: InboundLead): LeadExtraction => {
  const next = structuredClone(extraction);
  const hintEmail = normalizeEmail(lead.hints.email);
  if (hintEmail) {
    next.email = { value: hintEmail, confidence: Math.max(next.email.confidence, 0.95) };
  }
  if (lead.hints.name && next.name.value === null) {
    next.name = { value: lead.hints.name, confidence: 0.9 };
  }
  if (lead.hints.company && next.company.value === null) {
    next.company = { value: lead.hints.company, confidence: 0.9 };
  }
  const hintPhone = normalizePhone(lead.hints.phone);
  if (hintPhone && next.phone.value === null) {
    next.phone = { value: hintPhone, confidence: 0.9 };
  }
  return next;
};

/**
 * Anti hallucination check: an email or phone number the model returns must
 * literally appear in the source. If not, use the rules value instead.
 */
const groundContactDetails = (
  extraction: LeadExtraction,
  lead: InboundLead,
  rules: LeadExtraction,
): { extraction: LeadExtraction; ungrounded: ExtractionField[] } => {
  const next = structuredClone(extraction);
  const ungrounded: ExtractionField[] = [];
  const haystack = groundingText(lead);
  const haystackDigits = digitsOnly(haystack);

  if (next.email.value !== null) {
    const copied = next.email.value.trim().toLowerCase();
    const email = normalizeEmail(copied);
    if (haystack.includes(copied) || (email !== null && haystack.includes(email))) {
      // Copied from the message. Keep it if valid; an invalid address is simply not an email.
      next.email = email ? { value: email, confidence: next.email.confidence } : { value: null, confidence: 0 };
    } else {
      ungrounded.push('email');
      next.email = rules.email;
    }
  }
  if (next.phone.value !== null) {
    const phone = normalizePhone(next.phone.value);
    const tail = digitsOnly(next.phone.value).slice(-9);
    if (phone && tail.length === 9 && haystackDigits.includes(tail)) {
      next.phone.value = phone;
    } else {
      ungrounded.push('phone');
      next.phone = rules.phone;
    }
  }
  return { extraction: next, ungrounded };
};

const fillGapsFromRules = (extraction: LeadExtraction, rules: LeadExtraction): LeadExtraction => {
  const next = structuredClone(extraction);
  for (const key of ['name', 'company', 'email', 'phone', 'need'] as const) {
    if (next[key].value === null && rules[key].value !== null) {
      next[key] = rules[key];
    }
  }
  return next;
};

export const lowConfidenceFields = (extraction: LeadExtraction, minConfidence: number): ExtractionField[] =>
  EXTRACTION_FIELDS.filter((key) => {
    const item = extraction[key];
    const hasValue = item.value !== null && item.value !== 'unknown';
    return hasValue && item.confidence < minConfidence;
  });

/** True when the model is not sure enough about the things routing depends on. */
const needsHumanForConfidence = (extraction: LeadExtraction, minConfidence: number): boolean => {
  if (extraction.intent.confidence < minConfidence) {
    return true;
  }
  if (extraction.intent.value !== 'sales_lead') {
    return false;
  }
  const emailOk = extraction.email.value !== null && extraction.email.confidence >= minConfidence;
  const phoneOk = extraction.phone.value !== null && extraction.phone.confidence >= minConfidence;
  return !emailOk && !phoneOk;
};

export const createLeadExtractor = (deps: LeadExtractorDeps): LeadExtractor => ({
  extract: async (lead) => {
    const rules = extractWithRules(lead);
    const fallback = (reason: FallbackReason, detail: string | null, aiLatencyMs: number | null): ExtractionDecision => {
      deps.metrics.inc('ai.fallback');
      deps.metrics.inc(`ai.fallback.${reason}`);
      deps.logger.warn('extraction.fallback', { reason, idempotencyKey: lead.idempotencyKey });
      return {
        extraction: rules,
        method: 'rules',
        fallbackReason: reason,
        fallbackDetail: detail,
        lowConfidenceFields: lowConfidenceFields(rules, deps.minConfidence),
        aiLatencyMs,
      };
    };

    if (!deps.ai) {
      return fallback('ai_disabled', 'No ANTHROPIC_API_KEY configured', null);
    }

    deps.metrics.inc('ai.calls');
    const outcome = await deps.ai.extract(lead);
    if (!outcome.ok) {
      return fallback(outcome.reason, outcome.detail, outcome.latencyMs);
    }

    const hinted = applyHints(outcome.extraction, lead);
    const grounded = groundContactDetails(hinted, lead, rules);
    let extraction = grounded.extraction;
    let fallbackReason: FallbackReason | null = null;
    let fallbackDetail: string | null = null;

    if (grounded.ungrounded.length > 0) {
      fallbackReason = 'ungrounded';
      fallbackDetail = `Model returned ${grounded.ungrounded.join(' and ')} not found in the message`;
    } else if (needsHumanForConfidence(extraction, deps.minConfidence)) {
      fallbackReason = 'low_confidence';
      fallbackDetail = `Intent or contact details below ${String(deps.minConfidence)} confidence`;
      extraction = fillGapsFromRules(extraction, rules);
    }

    if (fallbackReason !== null) {
      deps.metrics.inc('ai.fallback');
      deps.metrics.inc(`ai.fallback.${fallbackReason}`);
      deps.logger.warn('extraction.fallback', { reason: fallbackReason, idempotencyKey: lead.idempotencyKey });
    }

    return {
      extraction,
      method: 'ai',
      fallbackReason,
      fallbackDetail,
      lowConfidenceFields: lowConfidenceFields(extraction, deps.minConfidence),
      aiLatencyMs: outcome.latencyMs,
    };
  },
});
