import { describe, expect, it } from 'vitest';
import { formatReport, runDemo } from '../../demo/run-demo.ts';

describe('npm run demo', () => {
  it('replays the 25 synthetic leads and every self check passes', async () => {
    const result = await runDemo();
    expect(result.checks.filter((check) => !check.ok)).toEqual([]);
    expect(result.numbers).toMatchObject({
      inbound: 25,
      unique: 22,
      duplicatesBlocked: 3,
      merged: 2,
      autoDrafted: 10,
      humanReview: 5,
      spam: 4,
      support: 1,
      aiFallback: 5,
      hubspot429: 12,
      deadLettered: 2,
      replayed: 2,
      replaySucceeded: 2,
      deadLettersPending: 0,
      dealsCreated: 11,
      duplicateDeals: 0,
      lost: 0,
      reminders: 8,
    });
    const report = formatReport(result);
    expect(report).toContain('Synthetic data only');
    expect(report).toContain('[PASS] No duplicate deals');
    expect(report).not.toMatch(/[\u2013\u2014]/);
  });
});
