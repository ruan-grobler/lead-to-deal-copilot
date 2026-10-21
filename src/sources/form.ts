import { z } from 'zod';
import { normalizeEmail, normalizePhone } from '../domain/normalize.ts';
import type { InboundLead, LeadHints } from '../domain/types.ts';
import { formIdempotencyKey } from '../reliability/idempotency.ts';

/**
 * A generic website form payload. Only `message` is required: a lead with a
 * broken email field is still a lead, it just goes to human review.
 */
export const FormSubmissionSchema = z.object({
  submissionId: z.string().trim().min(1).max(200).optional(),
  name: z.string().trim().max(200).optional(),
  email: z.string().trim().max(320).optional(),
  company: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(50).optional(),
  website: z.string().trim().max(500).optional(),
  subject: z.string().trim().max(500).optional(),
  message: z.string().trim().min(1, 'message is required').max(20_000),
  page: z.string().trim().max(500).optional(),
  submittedAt: z.string().trim().max(64).optional(),
});

export type FormSubmission = z.infer<typeof FormSubmissionSchema>;

const nonEmpty = (value: string | undefined): string | undefined => (value && value.length > 0 ? value : undefined);

export const formSubmissionToLead = (payload: FormSubmission, receivedAt: Date): InboundLead => {
  const parseWarnings: string[] = [];
  const email = normalizeEmail(payload.email);
  if (payload.email && !email) {
    parseWarnings.push('invalid_email_field');
  }
  const phone = normalizePhone(payload.phone);

  const hints: LeadHints = {};
  const name = nonEmpty(payload.name);
  const company = nonEmpty(payload.company);
  const website = nonEmpty(payload.website);
  if (name) {
    hints.name = name;
  }
  if (email) {
    hints.email = email;
  }
  if (company) {
    hints.company = company;
  }
  if (phone) {
    hints.phone = phone;
  }
  if (website) {
    hints.website = website;
  }

  const meta: Record<string, string> = {};
  if (payload.submissionId) {
    meta.submissionId = payload.submissionId;
  }
  if (payload.page) {
    meta.page = payload.page;
  }
  if (payload.email && !email) {
    meta.rawEmailField = payload.email.slice(0, 320);
  }

  return {
    source: 'form',
    idempotencyKey: formIdempotencyKey(payload),
    receivedAt: receivedAt.toISOString(),
    subject: nonEmpty(payload.subject) ?? null,
    text: payload.message,
    hints,
    meta,
    parseWarnings,
  };
};
