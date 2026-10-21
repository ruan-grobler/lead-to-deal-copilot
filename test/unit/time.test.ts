import { describe, expect, it } from 'vitest';
import { formatDuration, isDailyRunDue, localDateKey, localDateLabel, localTimeLabel, nextDailyRun, zonedParts, zonedTimeToUtc } from '../../src/scheduler/time.ts';

const JHB = { hour: 8, minute: 0, timeZone: 'Africa/Johannesburg' };

describe('time zone helpers', () => {
  it('reads wall clock time in Cape Town (UTC+2, no daylight saving)', () => {
    const parts = zonedParts(new Date('2026-10-21T06:00:00Z'), 'Africa/Johannesburg');
    expect(parts).toMatchObject({ year: 2026, month: 10, day: 21, hour: 8, minute: 0, weekday: 'Wed' });
    expect(localDateKey(new Date('2026-10-20T22:30:00Z'), 'Africa/Johannesburg')).toBe('2026-10-21');
    expect(localDateLabel(new Date('2026-10-21T06:00:00Z'), 'Africa/Johannesburg')).toBe('Wed 21 Oct 2026');
    expect(localTimeLabel(new Date('2026-10-21T06:05:00Z'), 'Africa/Johannesburg')).toBe('08:05');
  });

  it('converts a local wall clock time to UTC', () => {
    expect(zonedTimeToUtc(2026, 10, 21, 8, 0, 'Africa/Johannesburg').toISOString()).toBe('2026-10-21T06:00:00.000Z');
    // London in summer time is UTC+1, in winter UTC+0: the conversion follows the offset of that date.
    expect(zonedTimeToUtc(2026, 7, 1, 8, 0, 'Europe/London').toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(zonedTimeToUtc(2026, 12, 1, 8, 0, 'Europe/London').toISOString()).toBe('2026-12-01T08:00:00.000Z');
  });

  it('schedules the next 08:00 run in Africa/Johannesburg', () => {
    expect(nextDailyRun(new Date('2026-10-21T05:59:00Z'), JHB).toISOString()).toBe('2026-10-21T06:00:00.000Z');
    expect(nextDailyRun(new Date('2026-10-21T06:00:00Z'), JHB).toISOString()).toBe('2026-10-22T06:00:00.000Z');
    expect(nextDailyRun(new Date('2026-12-31T20:00:00Z'), JHB).toISOString()).toBe('2027-01-01T06:00:00.000Z');
  });

  it('knows when the daily run is due', () => {
    expect(isDailyRunDue(new Date('2026-10-21T05:59:00Z'), JHB)).toBe(false);
    expect(isDailyRunDue(new Date('2026-10-21T06:00:00Z'), JHB)).toBe(true);
    expect(isDailyRunDue(new Date('2026-10-21T21:00:00Z'), JHB)).toBe(true);
  });

  it('formats durations', () => {
    expect(formatDuration(5)).toBe('5 min');
    expect(formatDuration(120)).toBe('2 h');
    expect(formatDuration(125.4)).toBe('2 h 5 min');
    expect(formatDuration(-3)).toBe('0 min');
  });
});
