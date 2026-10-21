import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { signBody, verifySignature } from '../../src/http/signature.ts';
import { parseEmailToLead, stripQuotedReply } from '../../src/sources/email.ts';
import { FormSubmissionSchema, formSubmissionToLead } from '../../src/sources/form.ts';
import { slackMessageToLead } from '../../src/sources/slack-message.ts';

const fixture = (name: string): Buffer => readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'email', name));
const now = new Date('2026-10-20T07:00:00.000Z');

describe('email source', () => {
  it('parses a clean message into a lead with sender hints', async () => {
    const lead = await parseEmailToLead(fixture('e01-noordhoek-brewing.eml'), now);
    expect(lead.idempotencyKey).toBe('email:taproom-2026-10-20@noordhoek-brewing.example.com');
    expect(lead.hints).toEqual({ email: 'pieter@noordhoek-brewing.example.com', name: 'Pieter van Wyk' });
    expect(lead.subject).toBe('Network and Wi-Fi for our new taproom');
    expect(lead.parseWarnings).toEqual([]);
    expect(lead.text).toContain('R90 000');
  });

  it('drops the quoted history of a reply', async () => {
    const lead = await parseEmailToLead(fixture('e02-silvertree-followup.eml'), now);
    expect(lead.text).toContain('Following up on the form I sent this morning');
    expect(lead.text).not.toContain('A consultant will contact you');
    expect(lead.text).not.toContain('wrote:');
  });

  it('keeps a malformed message as a lead with warnings instead of failing', async () => {
    const lead = await parseEmailToLead(fixture('e03-malformed.eml'), now);
    expect(lead.parseWarnings).toContain('invalid_from_address');
    expect(lead.hints.email).toBeUndefined();
    expect(lead.hints.name).toBe('Lerato Nkosi');
    expect(lead.meta.rawFrom).toBe('lerato[at]example.com');
    expect(lead.idempotencyKey).toMatch(/^email:sha256:/);
    expect(lead.text).toContain('000 000 0007');
  });

  it('reads HTML only messages', async () => {
    const lead = await parseEmailToLead(fixture('e04-phishing.eml'), now);
    expect(lead.text).toContain('Your mailbox has reached 98% of its quota');
    expect(lead.text).not.toContain('<p>');
  });

  it('survives input that is not a MIME message at all', async () => {
    const lead = await parseEmailToLead('just some words, no headers', now);
    expect(lead.parseWarnings).toContain('missing_from');
    expect(lead.text).toContain('just some words');
  });

  it('flags an empty body', async () => {
    const lead = await parseEmailToLead('From: a@example.com\r\nSubject: hi\r\n\r\n', now);
    expect(lead.parseWarnings).toContain('empty_body');
  });

  it('prefers a valid Reply-To over the From address', async () => {
    const raw = 'From: "Relay" <noreply@forms.example.com>\r\nReply-To: "Jane Doe" <jane@company.example.com>\r\nSubject: Quote\r\nMessage-ID: <r1@forms.example.com>\r\n\r\nPlease quote for 10 laptops.';
    const lead = await parseEmailToLead(raw, now);
    expect(lead.hints).toEqual({ email: 'jane@company.example.com', name: 'Jane Doe' });
  });

  it('strips quoted replies in Outlook style too', () => {
    expect(stripQuotedReply('New text\n-----Original Message-----\nOld text')).toBe('New text');
  });
});

describe('form source', () => {
  it('requires a message but nothing else', () => {
    expect(FormSubmissionSchema.safeParse({ email: 'a@example.com' }).success).toBe(false);
    expect(FormSubmissionSchema.safeParse({ message: 'hi there' }).success).toBe(true);
  });

  it('keeps a lead with a broken email field and flags it', () => {
    const lead = formSubmissionToLead(FormSubmissionSchema.parse({ name: 'asdf', email: 'asdf@asdf', message: 'test test 123' }), now);
    expect(lead.parseWarnings).toEqual(['invalid_email_field']);
    expect(lead.hints.email).toBeUndefined();
    expect(lead.meta.rawEmailField).toBe('asdf@asdf');
    expect(lead.idempotencyKey).toMatch(/^form:sha256:/);
  });

  it('normalises contact fields into hints', () => {
    const lead = formSubmissionToLead(
      FormSubmissionSchema.parse({ submissionId: 'wf_1', name: 'Thandi', email: 'Thandi@Kestrel.example.com', phone: '+27 00 000 0001', company: 'Kestrel', website: 'kestrel.example.com', message: 'hi', page: '/contact' }),
      now,
    );
    expect(lead.idempotencyKey).toBe('form:wf_1');
    expect(lead.hints).toEqual({ name: 'Thandi', email: 'thandi@kestrel.example.com', phone: '+27000000001', company: 'Kestrel', website: 'kestrel.example.com' });
    expect(lead.meta).toEqual({ submissionId: 'wf_1', page: '/contact' });
  });
});

describe('slack source', () => {
  it('keys the lead on workspace, channel and message ts', () => {
    const lead = slackMessageToLead({ teamId: 'T1', channelId: 'C1', messageTs: '1.2', text: ' lead text ', authorUserId: 'U1', sharedByUserId: 'U2' }, now);
    expect(lead.idempotencyKey).toBe('slack:T1:C1:1.2');
    expect(lead.text).toBe('lead text');
    expect(lead.meta).toMatchObject({ author: 'U1', sharedBy: 'U2' });
    expect(slackMessageToLead({ teamId: 'T1', channelId: 'C1', messageTs: '1.3', text: '  ', authorUserId: null, sharedByUserId: 'U2' }, now).parseWarnings).toEqual(['empty_body']);
  });
});

describe('webhook signatures', () => {
  it('accepts a correct HMAC and rejects anything else', () => {
    const body = Buffer.from('{"message":"hi"}');
    const signature = signBody('secret', body);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature('secret', body, signature)).toBe(true);
    expect(verifySignature('other', body, signature)).toBe(false);
    expect(verifySignature('secret', Buffer.from('{"message":"changed"}'), signature)).toBe(false);
    expect(verifySignature('secret', body, undefined)).toBe(false);
    expect(verifySignature('secret', body, 'sha256=short')).toBe(false);
  });
});
