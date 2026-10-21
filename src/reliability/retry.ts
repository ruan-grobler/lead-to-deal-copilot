import { sleep as realSleep } from '../clock.ts';
import type { Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import { inspectError, OperationFailedError, type ErrorInfo } from './errors.ts';

export interface RetryPolicy {
  /** Total tries, including the first one. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Upper bound for a server supplied Retry-After before we give up and dead letter instead. */
  maxRetryAfterMs: number;
  retryOnTimeout: boolean;
}

export interface RetryDeps {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  logger?: Logger;
  metrics?: Metrics;
}

export interface RetryRunner {
  run: <T>(label: string, operation: () => Promise<T>) => Promise<T>;
  policy: RetryPolicy;
}

export const isRetryable = (info: ErrorInfo, policy: RetryPolicy): boolean => {
  if (info.kind === 'network') {
    return true;
  }
  if (info.kind === 'timeout') {
    return policy.retryOnTimeout;
  }
  if (info.kind === 'http' && info.status !== null) {
    return info.status === 429 || info.status >= 500;
  }
  return false;
};

/** Exponential backoff with full jitter: a random delay between 0 and base * 2^(attempt - 1), capped. */
export const backoffDelay = (attempt: number, policy: RetryPolicy, random: () => number): number => {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(random() * ceiling);
};

export const withRetry = async <T>(
  label: string,
  operation: () => Promise<T>,
  policy: RetryPolicy,
  deps: RetryDeps = {},
): Promise<T> => {
  const sleep = deps.sleep ?? realSleep;
  const random = deps.random ?? Math.random;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const info = inspectError(error);
      const retryable = isRetryable(info, policy);
      const retryAfterTooLong = info.retryAfterMs !== null && info.retryAfterMs > policy.maxRetryAfterMs;
      if (!retryable || retryAfterTooLong || attempt >= policy.maxAttempts) {
        deps.metrics?.inc(`retry.exhausted.${label}`);
        throw new OperationFailedError(label, attempt, info, retryable, error);
      }
      const jittered = backoffDelay(attempt, policy, random);
      const delayMs = info.retryAfterMs === null ? jittered : Math.max(info.retryAfterMs, jittered);
      deps.metrics?.inc('retry.scheduled');
      deps.metrics?.inc(`retry.scheduled.${label}`);
      deps.logger?.warn('retry.scheduled', { label, attempt, delayMs, status: info.status, kind: info.kind });
      await sleep(delayMs);
    }
  }
};

export const createRetryRunner = (policy: RetryPolicy, deps: RetryDeps = {}): RetryRunner => ({
  run: async (label, operation) => withRetry(label, operation, policy, deps),
  policy,
});

/** A seeded PRNG (mulberry32) so the demo's jitter, and so its counts, are reproducible. */
export const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
