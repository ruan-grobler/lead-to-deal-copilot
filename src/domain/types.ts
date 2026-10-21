import type { ExtractionField, LeadExtraction } from '../extraction/schema.ts';

export type LeadSource = 'form' | 'email' | 'slack';

/** Structured fields a source already knows, such as form fields or the email From header. */
export interface LeadHints {
  name?: string;
  email?: string;
  company?: string;
  phone?: string;
  website?: string;
}

/** One inbound message, normalised from any source, before extraction. */
export interface InboundLead {
  source: LeadSource;
  idempotencyKey: string;
  receivedAt: string;
  subject: string | null;
  text: string;
  hints: LeadHints;
  meta: Record<string, string>;
  /** Problems found while parsing the source. Any entry sends the lead to human review. */
  parseWarnings: string[];
}

export type Route = 'auto_draft' | 'human_review' | 'support' | 'spam';

export type LeadStatus =
  | 'received'
  | 'processing'
  | 'drafted'
  | 'merged'
  | 'needs_review'
  | 'support'
  | 'spam'
  | 'approved'
  | 'not_a_fit'
  | 'dead_lettered';

export type FallbackReason =
  | 'ai_disabled'
  | 'timeout'
  | 'api_error'
  | 'invalid_output'
  | 'refusal'
  | 'low_confidence'
  | 'ungrounded';

export type ExtractionMethod = 'ai' | 'rules';

export interface ExtractionDecision {
  extraction: LeadExtraction;
  method: ExtractionMethod;
  fallbackReason: FallbackReason | null;
  fallbackDetail: string | null;
  lowConfidenceFields: ExtractionField[];
  aiLatencyMs: number | null;
}

export type DedupeMatch = 'none' | 'contact_email' | 'company_domain';
