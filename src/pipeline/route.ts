import { isValidEmail } from '../domain/normalize.ts';
import type { ExtractionDecision, InboundLead, Route } from '../domain/types.ts';
import type { LeadExtraction } from '../extraction/schema.ts';

/**
 * The routing policy in one place. Anything the machine is unsure about goes
 * to a person. Nothing is dropped: spam is filtered but stays in the table
 * and shows up in the daily digest.
 */
export const decideRoute = (decision: ExtractionDecision, lead: InboundLead, minConfidence: number): Route => {
  if (decision.fallbackReason !== null) {
    return 'human_review';
  }
  const { intent, email } = decision.extraction;
  if (intent.value === 'spam' && intent.confidence >= minConfidence) {
    return 'spam';
  }
  if (lead.parseWarnings.length > 0) {
    return 'human_review';
  }
  if (intent.value === 'support' && intent.confidence >= minConfidence) {
    return 'support';
  }
  const hasEmail = email.value !== null && isValidEmail(email.value) && email.confidence >= minConfidence;
  if (intent.value === 'sales_lead' && intent.confidence >= minConfidence && hasEmail) {
    return 'auto_draft';
  }
  return 'human_review';
};

/** High value: over R1m, or R300k to R1m with high urgency. */
export const isPriority = (extraction: LeadExtraction): boolean => {
  if (extraction.intent.value !== 'sales_lead') {
    return false;
  }
  const band = extraction.budgetBand.value;
  return band === 'over_1m' || (band === '300k_to_1m' && extraction.urgency.value === 'high');
};
