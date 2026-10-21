import { describe, expect, it } from 'vitest';
import { createFakeClock, sleep } from '../../src/clock.ts';
import { ConfigError, loadConfig } from '../../src/config.ts';
import { createLogger, maskEmail, maskPhone } from '../../src/logger.ts';
import { createMetrics } from '../../src/metrics.ts';
import { createJobQueue } from '../../src/reliability/job-queue.ts';
import { createKeyedMutex } from '../../src/reliability/keyed-mutex.ts';
import { startScheduler } from '../../src/scheduler/scheduler.ts';

describe('config', () => {
  it('defaults to mock mode with safe values', () => {
    const config = loadConfig({});
    expect(config.mode).toBe('mock');
    expect(config.http.host).toBe('127.0.0.1');
    expect(config.ai.model).toBe('claude-opus-5-5');
    expect(config.ai.apiKey).toBeNull();
    expect(config.digest).toEqual({ hour: 8, minute: 0, timeZone: 'Africa/Johannesburg' });
    expect(config.remindAfterMinutes).toBe(120);
    expect(config.hubspot.stages).toEqual({ new: 'appointmentscheduled', approved: 'qualifiedtobuy', notAFit: 'closedlost' });
    expect(config.freeMailDomains.has('gmail.com')).toBe(true);
  });

  it('treats empty values as unset and extends the free mail list', () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: '', FREE_MAIL_DOMAINS: 'Mail.Example.org, other.example.org', HUBSPOT_APP_URL: 'https://app-eu1.hubspot.com/' });
    expect(config.ai.apiKey).toBeNull();
    expect(config.freeMailDomains.has('mail.example.org')).toBe(true);
    expect(config.hubspot.appUrl).toBe('https://app-eu1.hubspot.com');
  });

  it('refuses live mode without tokens, and bad values', () => {
    expect(() => loadConfig({ MODE: 'live' })).toThrow(ConfigError);
    expect(() => loadConfig({ MODE: 'live', HUBSPOT_ACCESS_TOKEN: 'a', SLACK_BOT_TOKEN: 'b', SLACK_APP_TOKEN: 'c' })).not.toThrow();
    expect(() => loadConfig({ DIGEST_TIME: '8am' })).toThrow('DIGEST_TIME');
    expect(() => loadConfig({ DIGEST_TIMEZONE: 'Mars/Olympus' })).toThrow('time zone');
    expect(() => loadConfig({ PORT: 'abc' })).toThrow('PORT');
  });
});

describe('logger', () => {
  it('writes one JSON object per line with bindings, and respects the level', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', write: (line) => lines.push(line), now: () => new Date('2026-10-20T07:00:00Z') });
    logger.debug('hidden');
    logger.child({ leadId: 7 }).info('lead.processed', { status: 'drafted', error: new Error('boom') });
    logger.warn('w');
    logger.error('e');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] ?? '{}')).toEqual({ ts: '2026-10-20T07:00:00.000Z', level: 'info', msg: 'lead.processed', leadId: 7, status: 'drafted', error: { name: 'Error', message: 'boom' } });
  });

  it('masks contact details', () => {
    expect(maskEmail('thandi@kestrel-freight.example.com')).toBe('t***@kestrel-freight.example.com');
    expect(maskEmail('bad')).toBe('***');
    expect(maskEmail(null)).toBeNull();
    expect(maskPhone('+27 00 000 0001')).toBe('***0001');
    expect(maskPhone('12')).toBe('***');
    expect(maskPhone(undefined)).toBeNull();
  });
});

describe('concurrency helpers', () => {
  it('runs tasks with the same key one after the other, other keys in parallel', async () => {
    const mutex = createKeyedMutex();
    const events: string[] = [];
    const task = (name: string, ms: number) => async (): Promise<void> => {
      events.push(`${name}:start`);
      await sleep(ms);
      events.push(`${name}:end`);
    };
    await Promise.all([mutex.runExclusive('a', task('a1', 20)), mutex.runExclusive('a', task('a2', 1)), mutex.runExclusive('b', task('b1', 1))]);
    expect(events.indexOf('a1:end')).toBeLessThan(events.indexOf('a2:start'));
    expect(events.indexOf('b1:start')).toBeLessThan(events.indexOf('a1:end'));
    expect(mutex.activeKeys()).toBe(0);
  });

  it('releases the lock when a task throws', async () => {
    const mutex = createKeyedMutex();
    await expect(mutex.runExclusive('k', async () => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    await expect(mutex.runExclusive('k', async () => Promise.resolve('next'))).resolves.toBe('next');
  });

  it('queues jobs with a concurrency limit and reports errors without stopping', async () => {
    const errors: unknown[] = [];
    const queue = createJobQueue(2, (error) => errors.push(error));
    let running = 0;
    let peak = 0;
    const job = async (): Promise<void> => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(5);
      running -= 1;
    };
    await queue.onIdle();
    for (let index = 0; index < 5; index += 1) {
      queue.push(job);
    }
    queue.push(async () => Promise.reject(new Error('bad job')));
    expect(queue.size()).toBe(6);
    await queue.onIdle();
    expect(peak).toBe(2);
    expect(errors).toHaveLength(1);
    expect(queue.running()).toBe(0);
  });

  it('runs scheduled tasks, skips overlapping ticks and survives a failing task', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'error', write: (line) => lines.push(line) });
    let runs = 0;
    const scheduler = startScheduler(
      [
        { name: 'broken', run: async () => Promise.reject(new Error('nope')) },
        {
          name: 'counter',
          run: async () => {
            runs += 1;
            await sleep(5);
          },
        },
      ],
      60_000,
      logger,
    );
    await Promise.all([scheduler.tick(), scheduler.tick()]);
    scheduler.stop();
    expect(runs).toBe(1);
    expect(lines.some((line) => line.includes('scheduler.task_failed'))).toBe(true);
  });

  it('has a controllable fake clock and counters', () => {
    const clock = createFakeClock(new Date('2026-10-20T07:00:00Z'));
    clock.advance(60_000);
    expect(clock.now().toISOString()).toBe('2026-10-20T07:01:00.000Z');
    clock.set(new Date('2026-10-21T06:00:00Z'));
    expect(clock.now().toISOString()).toBe('2026-10-21T06:00:00.000Z');
    const metrics = createMetrics();
    metrics.inc('b');
    metrics.inc('a', 2);
    expect(metrics.snapshot()).toEqual({ a: 2, b: 1 });
    expect(metrics.get('missing')).toBe(0);
  });
});
