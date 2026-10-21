import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS } from '../../src/clock.ts';
import { buildDigestView } from '../../src/pipeline/digest.ts';
import { FormSubmissionSchema, formSubmissionToLead } from '../../src/sources/form.ts';
import { createHarness, formPayload, START, type Harness } from '../helpers/harness.ts';

const addLead = async (h: Harness, overrides: Record<string, string> = {}): Promise<number> => {
  const outcome = h.runtime.processor.ingest(formSubmissionToLead(FormSubmissionSchema.parse(formPayload(overrides)), h.clock.now()));
  await h.runtime.processor.process(outcome.leadId);
  return outcome.leadId;
};

describe('reminders and the daily digest', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness({ env: { SLACK_SALES_LEAD_USER_ID: 'U0LEAD' } });
  });

  afterEach(async () => {
    await h.close();
  });

  it('reminds once on a card nobody touched for two hours', async () => {
    const untouched = await addLead(h, { email: 'a@one.example.com' });
    const assigned = await addLead(h, { email: 'b@two.example.com' });
    h.runtime.repo.recordAssignment(assigned, 'U0SOMEONE', h.clock.now());

    h.clock.advance(119 * MINUTE_MS);
    expect((await h.runtime.runReminders()).reminded).toBe(0);
    h.clock.advance(2 * MINUTE_MS);
    expect(await h.runtime.runReminders()).toEqual({ reminded: 1, failed: 0 });
    expect(await h.runtime.runReminders()).toEqual({ reminded: 0, failed: 0 });

    const reminder = h.slack.threadReplies('#sales')[0];
    expect(reminder?.threadTs).toBe(h.runtime.repo.getLead(untouched)?.slackTs);
    expect(reminder?.text).toContain('has waited 2 h 1 min');
    expect(reminder?.text).toContain('<@U0LEAD>');
  });

  it('counts a failed reminder and tries again on the next sweep', async () => {
    await addLead(h);
    h.clock.advance(3 * HOUR_MS);
    h.slack.failNext(3, 500);
    expect(await h.runtime.runReminders()).toEqual({ reminded: 0, failed: 1 });
    expect(await h.runtime.runReminders()).toEqual({ reminded: 1, failed: 0 });
  });

  it('posts the digest from 08:00 Africa/Johannesburg, once per day', async () => {
    await addLead(h);
    h.clock.set(new Date('2026-10-21T05:59:00.000Z'));
    expect(await h.runtime.runDigest()).toEqual({ posted: false, date: '2026-10-21' });
    h.clock.set(new Date('2026-10-21T06:00:00.000Z'));
    expect(await h.runtime.runDigest()).toEqual({ posted: true, date: '2026-10-21' });
    expect(await h.runtime.runDigest()).toEqual({ posted: false, date: '2026-10-21' });
    const digest = h.slack.messages.find((message) => message.text.startsWith('Lead digest'));
    expect(digest?.text).toBe('Lead digest for Wed 21 Oct 2026: 1 received, 1 auto drafted, 0 needed review, 1 waiting for a decision.');
    h.clock.set(new Date('2026-10-22T06:30:00.000Z'));
    expect(await h.runtime.runDigest()).toEqual({ posted: true, date: '2026-10-22' });
  });

  it('releases the day when posting fails, so the next tick retries', async () => {
    h.clock.set(new Date('2026-10-21T06:00:00.000Z'));
    h.slack.failNext(3, 500);
    await expect(h.runtime.runDigest()).rejects.toThrow('slack.chat.postMessage');
    expect(await h.runtime.runDigest()).toEqual({ posted: true, date: '2026-10-21' });
  });

  it('builds digest numbers from the last 24 hours', async () => {
    await addLead(h);
    h.clock.set(new Date(START.getTime() + 25 * HOUR_MS));
    await addLead(h, { email: 'later@three.example.com' });
    const view = buildDigestView(h.runtime.repo, h.clock.now(), 'Africa/Johannesburg');
    expect(view).toMatchObject({ received: 1, autoDrafted: 1, waitingTotal: 2, deadLettersPending: 0 });
  });
});
