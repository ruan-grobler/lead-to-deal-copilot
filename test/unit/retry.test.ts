import Anthropic from '@anthropic-ai/sdk';
import { WebAPIHTTPError, WebAPIPlatformError, WebAPIRateLimitedError, WebAPIRequestError } from '@slack/web-api';
import { describe, expect, it } from 'vitest';
import { createMetrics } from '../../src/metrics.ts';
import { inspectError, OperationFailedError, parseRetryAfter } from '../../src/reliability/errors.ts';
import { backoffDelay, createRetryRunner, isRetryable, seededRandom, withRetry, type RetryPolicy } from '../../src/reliability/retry.ts';

const policy: RetryPolicy = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 1_000, maxRetryAfterMs: 5_000, retryOnTimeout: false };

/** Shaped like the ApiException HubSpot's generated client throws. */
const hubspotError = (code: number, headers: Record<string, string> = {}): Error =>
  Object.assign(new Error(`HTTP-Code: ${String(code)}`), { code, body: { message: 'x' }, headers });

const recordSleeps = (): { sleeps: number[]; sleep: (ms: number) => Promise<void> } => {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
};

describe('backoff', () => {
  it('uses full jitter under an exponential ceiling, capped at maxDelayMs', () => {
    expect(backoffDelay(1, policy, () => 1)).toBe(100);
    expect(backoffDelay(2, policy, () => 1)).toBe(200);
    expect(backoffDelay(3, policy, () => 1)).toBe(400);
    expect(backoffDelay(5, policy, () => 1)).toBe(1_000);
    expect(backoffDelay(3, policy, () => 0.5)).toBe(200);
    expect(backoffDelay(3, policy, () => 0)).toBe(0);
  });

  it('has a reproducible seeded random source', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});

describe('withRetry', () => {
  it('retries 429 and 5xx, then succeeds', async () => {
    const { sleeps, sleep } = recordSleeps();
    let calls = 0;
    const metrics = createMetrics();
    const result = await withRetry(
      'hubspot.test',
      async () => {
        calls += 1;
        if (calls === 1) {
          throw hubspotError(429);
        }
        if (calls === 2) {
          throw hubspotError(502);
        }
        return Promise.resolve('ok');
      },
      policy,
      { sleep, random: () => 1, metrics },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleeps).toEqual([100, 200]);
    expect(metrics.get('retry.scheduled')).toBe(2);
  });

  it('honours Retry-After when it is longer than the jittered delay', async () => {
    const { sleeps, sleep } = recordSleeps();
    let calls = 0;
    await withRetry(
      'slack.test',
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new WebAPIRateLimitedError(2);
        }
        return Promise.resolve(true);
      },
      policy,
      { sleep, random: () => 0 },
    );
    expect(sleeps).toEqual([2_000]);
  });

  it('gives up straight away on a 4xx and reports one attempt', async () => {
    const { sleeps, sleep } = recordSleeps();
    const failure = withRetry('hubspot.bad_request', async () => Promise.reject(hubspotError(400)), policy, { sleep });
    await expect(failure).rejects.toMatchObject({ name: 'OperationFailedError', attempts: 1, retryable: false, label: 'hubspot.bad_request' });
    expect(sleeps).toEqual([]);
  });

  it('stops after maxAttempts and keeps the last error as the cause', async () => {
    const { sleep } = recordSleeps();
    const metrics = createMetrics();
    const error = await withRetry('hubspot.storm', async () => Promise.reject(hubspotError(429)), policy, { sleep, metrics }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OperationFailedError);
    const failed = error as OperationFailedError;
    expect(failed.attempts).toBe(4);
    expect(failed.info.status).toBe(429);
    expect(failed.message).toContain('HTTP 429');
    expect((failed.cause as Error).message).toContain('429');
    expect(metrics.get('retry.exhausted.hubspot.storm')).toBe(1);
  });

  it('does not wait out an absurd Retry-After, it fails so the lead can be dead lettered', async () => {
    const { sleeps, sleep } = recordSleeps();
    const failure = withRetry('hubspot.slow', async () => Promise.reject(hubspotError(429, { 'retry-after': '600' })), policy, { sleep });
    await expect(failure).rejects.toMatchObject({ attempts: 1, retryable: true });
    expect(sleeps).toEqual([]);
  });

  it('retries timeouts only when the policy says so', async () => {
    const { sleep } = recordSleeps();
    const timeout = new Anthropic.APIConnectionTimeoutError();
    await expect(withRetry('claude', async () => Promise.reject(timeout), policy, { sleep })).rejects.toMatchObject({ attempts: 1 });
    await expect(withRetry('claude', async () => Promise.reject(timeout), { ...policy, retryOnTimeout: true }, { sleep })).rejects.toMatchObject({ attempts: 4 });
  });

  it('exposes the policy on a runner', async () => {
    const runner = createRetryRunner(policy, { sleep: recordSleeps().sleep });
    expect(runner.policy).toBe(policy);
    await expect(runner.run('ok', async () => Promise.resolve(1))).resolves.toBe(1);
  });
});

describe('inspectError understands every SDK', () => {
  it('reads Anthropic errors', () => {
    const headers = new Headers({ 'retry-after': '3' });
    const rateLimited = new Anthropic.RateLimitError(429, { type: 'error' }, 'slow down', headers);
    expect(inspectError(rateLimited)).toMatchObject({ kind: 'http', status: 429, retryAfterMs: 3_000 });
    expect(inspectError(new Anthropic.APIConnectionError({ message: 'reset' }))).toMatchObject({ kind: 'network' });
    expect(inspectError(new Anthropic.APIConnectionTimeoutError())).toMatchObject({ kind: 'timeout' });
  });

  it('reads Slack errors', () => {
    expect(inspectError(new WebAPIHTTPError(503, 'Service Unavailable', { 'retry-after': '1' }))).toMatchObject({ kind: 'http', status: 503, retryAfterMs: 1_000 });
    expect(inspectError(new WebAPIRequestError(new Error('socket hang up')))).toMatchObject({ kind: 'network' });
    expect(inspectError(new WebAPIPlatformError({ ok: false, error: 'channel_not_found' }))).toMatchObject({ status: 400 });
    expect(inspectError(new WebAPIPlatformError({ ok: false, error: 'ratelimited' }))).toMatchObject({ status: 503 });
  });

  it('reads HubSpot, fetch and unknown errors', () => {
    expect(inspectError(hubspotError(409))).toMatchObject({ kind: 'http', status: 409 });
    expect(inspectError(new TypeError('fetch failed'))).toMatchObject({ kind: 'network' });
    expect(inspectError(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))).toMatchObject({ kind: 'timeout' });
    expect(inspectError('weird')).toMatchObject({ kind: 'other', message: 'weird' });
  });

  it('parses Retry-After as seconds or a date', () => {
    expect(parseRetryAfter('1.5')).toBe(1_500);
    expect(parseRetryAfter('Wed, 21 Oct 2026 08:00:10 GMT', Date.parse('2026-10-21T08:00:00Z'))).toBe(10_000);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });

  it('classifies retryable errors', () => {
    expect(isRetryable({ kind: 'http', status: 404, retryAfterMs: null, message: '' }, policy)).toBe(false);
    expect(isRetryable({ kind: 'http', status: 500, retryAfterMs: null, message: '' }, policy)).toBe(true);
    expect(isRetryable({ kind: 'network', status: null, retryAfterMs: null, message: '' }, policy)).toBe(true);
    expect(isRetryable({ kind: 'other', status: null, retryAfterMs: null, message: '' }, policy)).toBe(false);
  });
});
