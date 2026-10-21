import Anthropic from '@anthropic-ai/sdk';
import { WebAPIHTTPError, WebAPIPlatformError, WebAPIRateLimitedError, WebAPIRequestError } from '@slack/web-api';

export type ErrorKind = 'http' | 'network' | 'timeout' | 'other';

export interface ErrorInfo {
  kind: ErrorKind;
  status: number | null;
  retryAfterMs: number | null;
  message: string;
}

/** Retry-After is either seconds or an HTTP date. */
export const parseRetryAfter = (value: string | null | undefined, now: number = Date.now()): number | null => {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
};

const headerValue = (headers: unknown, name: string): string | null => {
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  if (headers && typeof headers === 'object') {
    const record = headers as Record<string, unknown>;
    const direct = record[name] ?? record[name.toLowerCase()];
    return typeof direct === 'string' ? direct : null;
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** HubSpot's generated clients throw ApiException objects that carry the HTTP status in `code`. */
const isHubSpotApiException = (error: unknown): error is { code: number; headers: unknown; message: string; body: unknown } =>
  isRecord(error) && typeof error.code === 'number' && 'body' in error && 'headers' in error;

const SLACK_RETRYABLE_PLATFORM_ERRORS = new Set(['ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout']);

/** One place that understands the error shapes of all three SDKs. */
export const inspectError = (error: unknown): ErrorInfo => {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof OperationFailedError) {
    return error.info;
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return { kind: 'timeout', status: null, retryAfterMs: null, message };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { kind: 'network', status: null, retryAfterMs: null, message };
  }
  if (error instanceof Anthropic.APIError) {
    return {
      kind: 'http',
      status: typeof error.status === 'number' ? error.status : null,
      retryAfterMs: parseRetryAfter(headerValue(error.headers, 'retry-after')),
      message,
    };
  }
  if (error instanceof WebAPIRateLimitedError) {
    return { kind: 'http', status: 429, retryAfterMs: error.retryAfter * 1000, message };
  }
  if (error instanceof WebAPIHTTPError) {
    return { kind: 'http', status: error.statusCode, retryAfterMs: parseRetryAfter(headerValue(error.headers, 'retry-after')), message };
  }
  if (error instanceof WebAPIRequestError) {
    return { kind: 'network', status: null, retryAfterMs: null, message };
  }
  if (error instanceof WebAPIPlatformError) {
    const status = SLACK_RETRYABLE_PLATFORM_ERRORS.has(error.data.error) ? 503 : 400;
    return { kind: 'http', status, retryAfterMs: null, message: `slack: ${error.data.error}` };
  }
  if (isHubSpotApiException(error)) {
    return {
      kind: 'http',
      status: error.code,
      retryAfterMs: parseRetryAfter(headerValue(error.headers, 'retry-after')),
      message: `hubspot ${String(error.code)}: ${message}`,
    };
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return { kind: 'timeout', status: null, retryAfterMs: null, message };
  }
  if (error instanceof TypeError && message.includes('fetch failed')) {
    return { kind: 'network', status: null, retryAfterMs: null, message };
  }
  return { kind: 'other', status: null, retryAfterMs: null, message };
};

/** Thrown when an outbound call fails for good: retries exhausted, or the error is not retryable. */
export class OperationFailedError extends Error {
  readonly label: string;
  readonly attempts: number;
  readonly info: ErrorInfo;
  readonly retryable: boolean;

  constructor(label: string, attempts: number, info: ErrorInfo, retryable: boolean, cause: unknown) {
    const status = info.status === null ? info.kind : `HTTP ${String(info.status)}`;
    super(`${label} failed after ${String(attempts)} attempt${attempts === 1 ? '' : 's'} (${status}): ${info.message}`, { cause });
    this.name = 'OperationFailedError';
    this.label = label;
    this.attempts = attempts;
    this.info = info;
    this.retryable = retryable;
  }
}

export const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));
