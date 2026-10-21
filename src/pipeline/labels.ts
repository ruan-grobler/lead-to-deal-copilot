import type { FallbackReason, LeadSource } from '../domain/types.ts';
import type { BudgetBand, Intent, Urgency } from '../extraction/schema.ts';

export const BUDGET_LABELS: Record<BudgetBand, string> = {
  under_50k: 'Under R50k',
  '50k_to_300k': 'R50k to R300k',
  '300k_to_1m': 'R300k to R1m',
  over_1m: 'Over R1m',
  unknown: 'Not stated',
};

export const URGENCY_LABELS: Record<Urgency, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unknown: 'Not stated',
};

export const INTENT_LABELS: Record<Intent, string> = {
  sales_lead: 'Sales lead',
  support: 'Support request',
  spam: 'Spam',
};

export const SOURCE_LABELS: Record<LeadSource, string> = {
  form: 'website form',
  email: 'email',
  slack: 'Slack message',
};

export const FALLBACK_LABELS: Record<FallbackReason, string> = {
  ai_disabled: 'AI is switched off (no API key)',
  timeout: 'the AI call timed out',
  api_error: 'the AI service returned an error',
  invalid_output: 'the AI reply did not match the schema',
  refusal: 'the AI declined the request',
  low_confidence: 'the AI was not confident enough',
  ungrounded: 'the AI returned contact details that are not in the message',
};
