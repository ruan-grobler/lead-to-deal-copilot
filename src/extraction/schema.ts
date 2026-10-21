import { z } from 'zod';

export const INTENTS = ['sales_lead', 'support', 'spam'] as const;
export const BUDGET_BANDS = ['under_50k', '50k_to_300k', '300k_to_1m', 'over_1m', 'unknown'] as const;
export const URGENCIES = ['high', 'medium', 'low', 'unknown'] as const;

export type Intent = (typeof INTENTS)[number];
export type BudgetBand = (typeof BUDGET_BANDS)[number];
export type Urgency = (typeof URGENCIES)[number];

const confidence = z
  .number()
  .min(0)
  .max(1)
  .describe('0 to 1. 0.9 or more when the message states it directly, 0.5 to 0.8 when inferred, below 0.5 when guessing.');

const textField = (description: string): z.ZodObject<{
  value: z.ZodNullable<z.ZodString>;
  confidence: typeof confidence;
}> => z.object({ value: z.string().nullable().describe(description), confidence });

/**
 * The structured output Claude must return. The SDK turns this zod schema
 * into a JSON schema for the API, and the same schema validates the reply.
 */
export const LeadExtractionSchema = z.object({
  name: textField('Full name of the person who wrote the message, or null.'),
  company: textField('Company or organisation name, or null.'),
  email: textField('Email address copied exactly from the message or the sender fields, or null.'),
  phone: textField('Phone number copied exactly from the message, or null.'),
  need: textField('One plain English sentence describing what they want, or null.'),
  budgetBand: z.object({
    value: z.enum(BUDGET_BANDS).describe('Total budget in South African rand. Monthly amounts count as 12 months.'),
    confidence,
  }),
  urgency: z.object({
    value: z.enum(URGENCIES).describe('high: within a week, an outage or a hard deadline. medium: this quarter. low: exploring.'),
    confidence,
  }),
  intent: z.object({
    value: z.enum(INTENTS).describe('sales_lead: wants to buy or evaluate services. support: an existing customer needs help. spam: marketing, phishing, tests or gibberish.'),
    confidence,
  }),
  summary: z.string().describe('One line under 140 characters for the sales team Slack card.'),
});

export type LeadExtraction = z.infer<typeof LeadExtractionSchema>;

export const EXTRACTION_FIELDS = ['name', 'company', 'email', 'phone', 'need', 'budgetBand', 'urgency', 'intent'] as const;
export type ExtractionField = (typeof EXTRACTION_FIELDS)[number];
