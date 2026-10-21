import { z } from 'zod';
import { DEFAULT_FREE_MAIL_DOMAINS } from './domain/normalize.ts';
import type { LogLevel } from './logger.ts';
import type { RetryPolicy } from './reliability/retry.ts';

const optionalString = z.string().trim().min(1).optional();

const EnvSchema = z.object({
  MODE: z.enum(['mock', 'live']).default('mock'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_PATH: z.string().default('.data/copilot.db'),
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(1_000_000),
  FORM_WEBHOOK_SECRET: optionalString,
  EMAIL_WEBHOOK_SECRET: optionalString,

  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().default('claude-opus-5-5'),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  AI_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),

  HUBSPOT_ACCESS_TOKEN: optionalString,
  HUBSPOT_PORTAL_ID: optionalString,
  HUBSPOT_APP_URL: z.url().default('https://app.hubspot.com'),
  HUBSPOT_PIPELINE_ID: z.string().default('default'),
  HUBSPOT_STAGE_NEW: z.string().default('appointmentscheduled'),
  HUBSPOT_STAGE_APPROVED: z.string().default('qualifiedtobuy'),
  HUBSPOT_STAGE_NOT_A_FIT: z.string().default('closedlost'),
  HUBSPOT_MIN_TIME_MS: z.coerce.number().int().min(0).default(120),
  DEAL_MERGE_WINDOW_DAYS: z.coerce.number().int().min(0).default(30),

  SLACK_BOT_TOKEN: optionalString,
  SLACK_APP_TOKEN: optionalString,
  SLACK_SALES_CHANNEL: z.string().default('#sales'),
  SLACK_SUPPORT_CHANNEL: z.string().default('#support'),
  SLACK_ALERTS_CHANNEL: z.string().default('#sales-ops'),
  SLACK_SALES_LEAD_USER_ID: optionalString,

  REMIND_AFTER_MINUTES: z.coerce.number().int().positive().default(120),
  DIGEST_TIME: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, for example 08:00').default('08:00'),
  DIGEST_TIMEZONE: z.string().default('Africa/Johannesburg'),
  SCHEDULER_TICK_SECONDS: z.coerce.number().int().positive().default(60),
  FREE_MAIL_DOMAINS: optionalString,
});

export interface AppConfig {
  mode: 'mock' | 'live';
  logLevel: LogLevel;
  http: { host: string; port: number; maxBodyBytes: number; formSecret: string | null; emailSecret: string | null };
  databasePath: string;
  queueConcurrency: number;
  ai: { apiKey: string | null; model: string; timeoutMs: number; minConfidence: number };
  hubspot: {
    accessToken: string | null;
    portalId: string | null;
    appUrl: string;
    pipelineId: string;
    stages: { new: string; approved: string; notAFit: string };
    minTimeMs: number;
    mergeWindowDays: number;
  };
  slack: {
    botToken: string | null;
    appToken: string | null;
    salesChannel: string;
    supportChannel: string;
    alertsChannel: string;
    salesLeadUserId: string | null;
  };
  remindAfterMinutes: number;
  digest: { hour: number; minute: number; timeZone: string };
  schedulerTickMs: number;
  freeMailDomains: ReadonlySet<string>;
  retry: { hubspot: RetryPolicy; slack: RetryPolicy; ai: RetryPolicy };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const isValidTimeZone = (timeZone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
};

/** Live retry policies. The demo swaps in shorter delays and says so in its output. */
export const LIVE_RETRY_POLICIES: AppConfig['retry'] = {
  hubspot: { maxAttempts: 6, baseDelayMs: 500, maxDelayMs: 8_000, maxRetryAfterMs: 30_000, retryOnTimeout: true },
  slack: { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 5_000, maxRetryAfterMs: 30_000, retryOnTimeout: true },
  ai: { maxAttempts: 2, baseDelayMs: 1_000, maxDelayMs: 4_000, maxRetryAfterMs: 10_000, retryOnTimeout: false },
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  // Treat empty values (KEY= in .env) as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value.trim() !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;

  if (e.MODE === 'live') {
    const missing = (['HUBSPOT_ACCESS_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'] as const).filter((key) => e[key] === undefined);
    if (missing.length > 0) {
      throw new ConfigError(`MODE=live needs ${missing.join(', ')}. See .env.example and docs/live-setup.md.`);
    }
  }
  if (!isValidTimeZone(e.DIGEST_TIMEZONE)) {
    throw new ConfigError(`DIGEST_TIMEZONE is not a valid IANA time zone: ${e.DIGEST_TIMEZONE}`);
  }

  const [hour, minute] = e.DIGEST_TIME.split(':').map(Number);
  const extraFreeMail = (e.FREE_MAIL_DOMAINS ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);

  return {
    mode: e.MODE,
    logLevel: e.LOG_LEVEL,
    http: {
      host: e.HOST,
      port: e.PORT,
      maxBodyBytes: e.MAX_BODY_BYTES,
      formSecret: e.FORM_WEBHOOK_SECRET ?? null,
      emailSecret: e.EMAIL_WEBHOOK_SECRET ?? null,
    },
    databasePath: e.DATABASE_PATH,
    queueConcurrency: e.QUEUE_CONCURRENCY,
    ai: {
      apiKey: e.ANTHROPIC_API_KEY ?? null,
      model: e.ANTHROPIC_MODEL,
      timeoutMs: e.AI_TIMEOUT_MS,
      minConfidence: e.AI_MIN_CONFIDENCE,
    },
    hubspot: {
      accessToken: e.HUBSPOT_ACCESS_TOKEN ?? null,
      portalId: e.HUBSPOT_PORTAL_ID ?? null,
      appUrl: e.HUBSPOT_APP_URL.replace(/\/$/, ''),
      pipelineId: e.HUBSPOT_PIPELINE_ID,
      stages: { new: e.HUBSPOT_STAGE_NEW, approved: e.HUBSPOT_STAGE_APPROVED, notAFit: e.HUBSPOT_STAGE_NOT_A_FIT },
      minTimeMs: e.HUBSPOT_MIN_TIME_MS,
      mergeWindowDays: e.DEAL_MERGE_WINDOW_DAYS,
    },
    slack: {
      botToken: e.SLACK_BOT_TOKEN ?? null,
      appToken: e.SLACK_APP_TOKEN ?? null,
      salesChannel: e.SLACK_SALES_CHANNEL,
      supportChannel: e.SLACK_SUPPORT_CHANNEL,
      alertsChannel: e.SLACK_ALERTS_CHANNEL,
      salesLeadUserId: e.SLACK_SALES_LEAD_USER_ID ?? null,
    },
    remindAfterMinutes: e.REMIND_AFTER_MINUTES,
    digest: { hour: hour ?? 8, minute: minute ?? 0, timeZone: e.DIGEST_TIMEZONE },
    schedulerTickMs: e.SCHEDULER_TICK_SECONDS * 1000,
    freeMailDomains: new Set([...DEFAULT_FREE_MAIL_DOMAINS, ...extraFreeMail]),
    retry: LIVE_RETRY_POLICIES,
  };
};
