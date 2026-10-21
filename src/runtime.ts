import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import Anthropic from '@anthropic-ai/sdk';
import type { App, Receiver } from '@slack/bolt';
import { WebClient, type WebClientOptions } from '@slack/web-api';
import { systemClock, type Clock } from './clock.ts';
import type { AppConfig } from './config.ts';
import { createHubSpotClient, createHubSpotGateway, hubSpotDealUrl, type CrmGateway } from './crm/hubspot.ts';
import { openDatabase } from './db/database.ts';
import { createRepository, type Repository } from './db/repository.ts';
import { createClaudeExtractor } from './extraction/claude.ts';
import { createLeadExtractor, type LeadExtractor } from './extraction/extract.ts';
import { createHttpServer } from './http/server.ts';
import type { Logger } from './logger.ts';
import { createMetrics, type Metrics } from './metrics.ts';
import { createLeadActions, type LeadActions } from './pipeline/actions.ts';
import { recoverInterruptedLeads } from './pipeline/dead-letter.ts';
import { runDigestIfDue } from './pipeline/digest.ts';
import { createLeadProcessor, type LeadProcessor, type PipelineSettings } from './pipeline/processor.ts';
import { runReminderSweep } from './pipeline/reminders.ts';
import { createJobQueue, type JobQueue } from './reliability/job-queue.ts';
import { createKeyedMutex, type KeyedMutex } from './reliability/keyed-mutex.ts';
import { createRetryRunner, type RetryDeps } from './reliability/retry.ts';
import { startScheduler, type Scheduler } from './scheduler/scheduler.ts';
import { boltLogger, createSlackApp } from './slack/app.ts';
import { createSlackNotifier, type SlackNotifier } from './slack/notifier.ts';

export interface RuntimeOptions {
  config: AppConfig;
  logger: Logger;
  clock?: Clock;
  /** Override the database location, for example ':memory:' in tests and the demo. */
  databasePath?: string;
  /** Bolt receiver. Without one, live mode opens a Socket Mode connection. */
  slackReceiver?: Receiver;
  /** Injected into every retry runner, so the demo can use a seeded random and short sleeps. */
  retryDeps?: Pick<RetryDeps, 'random' | 'sleep'>;
}

export interface Runtime {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  metrics: Metrics;
  db: DatabaseSync;
  repo: Repository;
  queue: JobQueue;
  mutex: KeyedMutex;
  extractor: LeadExtractor;
  crm: CrmGateway;
  notifier: SlackNotifier;
  processor: LeadProcessor;
  actions: LeadActions;
  slackApp: App;
  httpServer: Server;
  runReminders: () => Promise<{ reminded: number; failed: number }>;
  runDigest: () => Promise<{ posted: boolean; date: string }>;
  start: () => Promise<{ port: number }>;
  stop: () => Promise<void>;
}

const MOCK_TOKENS = { hubspot: 'mock-hubspot-token', slackBot: 'xoxb-mock-token' };
const MOCK_BOT = { botId: 'B0MOCKBOT', botUserId: 'U0MOCKBOT' };

/**
 * Wires the whole object graph. Mock and live mode run the same code; only
 * the tokens differ, and in mock mode msw answers the HTTP calls in-process.
 */
export const createRuntime = (options: RuntimeOptions): Runtime => {
  const { config, logger } = options;
  const clock = options.clock ?? systemClock;
  const metrics = createMetrics();
  const live = config.mode === 'live';
  const retryDeps: RetryDeps = { ...options.retryDeps, logger, metrics };

  const db = openDatabase(options.databasePath ?? config.databasePath);
  const repo = createRepository(db);
  const queue = createJobQueue(config.queueConcurrency, (error) => {
    logger.error('queue.job_failed', { error: error instanceof Error ? error.message : String(error) });
  });
  const mutex = createKeyedMutex();

  const ai = config.ai.apiKey
    ? createClaudeExtractor({
        client: new Anthropic({ apiKey: config.ai.apiKey, maxRetries: 0 }),
        model: config.ai.model,
        timeoutMs: config.ai.timeoutMs,
        retry: createRetryRunner(config.retry.ai, retryDeps),
      })
    : null;
  if (!ai) {
    logger.warn('ai.disabled', { note: 'No ANTHROPIC_API_KEY, every lead uses fallback rules and goes to human review' });
  }
  const extractor = createLeadExtractor({ ai, minConfidence: config.ai.minConfidence, logger, metrics });

  const hubspotToken = live ? (config.hubspot.accessToken ?? '') : (config.hubspot.accessToken ?? MOCK_TOKENS.hubspot);
  const crm = createHubSpotGateway(
    createHubSpotClient(hubspotToken, live ? config.hubspot.minTimeMs : 0),
    createRetryRunner(config.retry.hubspot, retryDeps),
  );

  const slackToken = live ? (config.slack.botToken ?? '') : MOCK_TOKENS.slackBot;
  const slackClientOptions: WebClientOptions = {
    // Our retry runner owns retries. Rate limits surface as errors it can back off on.
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    logger: boltLogger(logger),
  };
  const notifier = createSlackNotifier({
    client: new WebClient(slackToken, slackClientOptions),
    retry: createRetryRunner(config.retry.slack, retryDeps),
    card: {
      dealUrl: (dealId) => hubSpotDealUrl(config.hubspot.appUrl, config.hubspot.portalId, dealId),
      salesLeadUserId: config.slack.salesLeadUserId,
      stageLabels: { approved: config.hubspot.stages.approved, notAFit: config.hubspot.stages.notAFit },
    },
    channels: { sales: config.slack.salesChannel, support: config.slack.supportChannel, alerts: config.slack.alertsChannel },
    salesLeadUserId: config.slack.salesLeadUserId,
  });

  const settings: PipelineSettings = {
    minConfidence: config.ai.minConfidence,
    pipelineId: config.hubspot.pipelineId,
    stageNew: config.hubspot.stages.new,
    mergeWindowDays: config.hubspot.mergeWindowDays,
    freeMailDomains: config.freeMailDomains,
  };
  const processor = createLeadProcessor({ repo, extractor, crm, slack: notifier, clock, logger, metrics, mutex, settings });
  const actions = createLeadActions({
    repo,
    crm,
    slack: notifier,
    clock,
    logger,
    metrics,
    mutex,
    settings,
    stages: { approved: config.hubspot.stages.approved, notAFit: config.hubspot.stages.notAFit },
  });

  const slackApp = createSlackApp({
    botToken: slackToken,
    appToken: config.slack.appToken,
    receiver: options.slackReceiver ?? null,
    botIdentity: live ? null : MOCK_BOT,
    clientOptions: slackClientOptions,
    logger,
    clock,
    processor,
    queue,
    actions,
    notifier,
  });

  const startedAt = clock.now();
  const httpServer = createHttpServer({
    processor,
    queue,
    repo,
    logger,
    metrics,
    clock,
    maxBodyBytes: config.http.maxBodyBytes,
    formSecret: config.http.formSecret,
    emailSecret: config.http.emailSecret,
    mode: config.mode,
    startedAt,
  });

  const runReminders = async (): Promise<{ reminded: number; failed: number }> =>
    runReminderSweep({ repo, slack: notifier, clock, logger, metrics, remindAfterMinutes: config.remindAfterMinutes });
  const runDigest = async (): Promise<{ posted: boolean; date: string }> =>
    runDigestIfDue({ repo, slack: notifier, clock, logger, metrics, schedule: config.digest });

  let scheduler: Scheduler | null = null;
  let slackStarted = false;

  return {
    config,
    logger,
    clock,
    metrics,
    db,
    repo,
    queue,
    mutex,
    extractor,
    crm,
    notifier,
    processor,
    actions,
    slackApp,
    httpServer,
    runReminders,
    runDigest,
    start: async () => {
      recoverInterruptedLeads({ repo, processor, clock, logger, metrics, queue }, 0);
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.http.port, config.http.host, () => {
          httpServer.off('error', reject);
          resolve();
        });
      });
      if (!options.slackReceiver) {
        await slackApp.start();
        slackStarted = true;
      }
      scheduler = startScheduler(
        [
          { name: 'reminders', run: runReminders },
          { name: 'digest', run: runDigest },
        ],
        config.schedulerTickMs,
        logger,
      );
      const address = httpServer.address() as AddressInfo;
      return { port: address.port };
    },
    stop: async () => {
      scheduler?.stop();
      if (httpServer.listening) {
        await new Promise<void>((resolve) => {
          httpServer.close(() => {
            resolve();
          });
        });
      }
      await queue.onIdle();
      if (slackStarted) {
        await slackApp.stop();
      }
      db.close();
    },
  };
};
