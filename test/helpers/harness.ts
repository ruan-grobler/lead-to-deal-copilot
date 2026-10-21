import { createFakeClock, type FakeClock } from '../../src/clock.ts';
import { loadConfig, type AppConfig } from '../../src/config.ts';
import type { LeadExtraction } from '../../src/extraction/schema.ts';
import { createLogger } from '../../src/logger.ts';
import { createAnthropicMock, type AnthropicBehavior, type AnthropicMock } from '../../src/mocks/anthropic-mock.ts';
import { createHubSpotMock, type HubSpotMock } from '../../src/mocks/hubspot-mock.ts';
import { startMockServer } from '../../src/mocks/mock-server.ts';
import { createSlackMock, type SlackMock } from '../../src/mocks/slack-mock.ts';
import { createRuntime, type Runtime } from '../../src/runtime.ts';
import { createInMemoryReceiver, type InMemoryReceiver } from '../../src/slack/in-memory-receiver.ts';

export const START = new Date('2026-10-20T07:00:00.000Z');

/** Tiny delays so retry tests run fast but still go through real sleeps. */
export const FAST_RETRY: AppConfig['retry'] = {
  hubspot: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 100, retryOnTimeout: true },
  slack: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 1_500, retryOnTimeout: true },
  ai: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2, maxRetryAfterMs: 100, retryOnTimeout: false },
};

type Field = [string | null, number];

export const extraction = (overrides: Partial<Record<'name' | 'company' | 'email' | 'phone' | 'need', Field>> & Partial<Pick<LeadExtraction, 'budgetBand' | 'urgency' | 'intent' | 'summary'>> = {}): LeadExtraction => {
  const field = (key: 'name' | 'company' | 'email' | 'phone' | 'need', fallback: Field): { value: string | null; confidence: number } => {
    const [value, confidence] = overrides[key] ?? fallback;
    return { value, confidence };
  };
  return {
    name: field('name', ['Test Person', 0.95]),
    company: field('company', ['Test Company', 0.95]),
    email: field('email', ['test.person@test-company.example.com', 0.97]),
    phone: field('phone', [null, 0]),
    need: field('need', ['Managed IT support for 20 staff.', 0.9]),
    budgetBand: overrides.budgetBand ?? { value: '50k_to_300k', confidence: 0.8 },
    urgency: overrides.urgency ?? { value: 'medium', confidence: 0.8 },
    intent: overrides.intent ?? { value: 'sales_lead', confidence: 0.95 },
    summary: overrides.summary ?? 'Test Company wants managed IT support for 20 staff.',
  };
};

export interface Harness {
  runtime: Runtime;
  config: AppConfig;
  hubspot: HubSpotMock;
  slack: SlackMock;
  anthropic: AnthropicMock;
  clock: FakeClock;
  receiver: InMemoryReceiver;
  logs: string[];
  /** Replaces the Claude mock's answer. Gets the rendered lead text. */
  setAi: (respond: (userText: string) => AnthropicBehavior) => void;
  baseUrl: () => string;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  env?: Record<string, string>;
  ai?: (userText: string) => AnthropicBehavior;
  /** Start the HTTP server on a random port. */
  listen?: boolean;
  retry?: AppConfig['retry'];
}

export const createHarness = async (options: HarnessOptions = {}): Promise<Harness> => {
  const clock = createFakeClock(START);
  const logs: string[] = [];
  const logger = createLogger({ level: 'debug', now: () => clock.now(), write: (line) => logs.push(line) });
  let respond = options.ai ?? ((): AnthropicBehavior => ({ kind: 'extraction', extraction: extraction() }));
  const anthropic = createAnthropicMock((text) => respond(text));
  const hubspot = createHubSpotMock({ now: () => clock.now() });
  const slack = createSlackMock();
  const server = startMockServer([...anthropic.handlers, ...hubspot.handlers, ...slack.handlers], { passthroughHosts: ['127.0.0.1'] });

  const config: AppConfig = {
    ...loadConfig({
      MODE: 'mock',
      HOST: '127.0.0.1',
      PORT: '0',
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      AI_TIMEOUT_MS: '300',
      QUEUE_CONCURRENCY: '1',
      SCHEDULER_TICK_SECONDS: '86400',
      ...options.env,
    }),
    retry: options.retry ?? FAST_RETRY,
  };
  const receiver = createInMemoryReceiver();
  const runtime = createRuntime({ config, logger, clock, databasePath: ':memory:', slackReceiver: receiver, retryDeps: { random: () => 0.5 } });
  let port = 0;
  if (options.listen) {
    port = (await runtime.start()).port;
  }

  return {
    runtime,
    config,
    hubspot,
    slack,
    anthropic,
    clock,
    receiver,
    logs,
    setAi: (next) => {
      respond = next;
    },
    baseUrl: () => `http://127.0.0.1:${String(port)}`,
    close: async () => {
      await runtime.stop();
      server.close();
    },
  };
};

/** A form submission for the given email, unique per call unless `submissionId` is passed. */
let formCounter = 0;
export const formPayload = (overrides: Record<string, string> = {}): Record<string, string> => {
  formCounter += 1;
  return {
    submissionId: `test_${String(formCounter)}`,
    name: 'Test Person',
    email: 'test.person@test-company.example.com',
    company: 'Test Company',
    message: `We need managed IT support for 20 staff (message ${String(formCounter)}).`,
    ...overrides,
  };
};

export const blockAction = (lead: { id: number; slackChannel: string | null; slackTs: string | null }, actionId: string, user: string): Record<string, unknown> => ({
  type: 'block_actions',
  team: { id: 'T0TEST', domain: 'test' },
  user: { id: user, username: user, name: user, team_id: 'T0TEST' },
  api_app_id: 'A0TEST',
  token: 'test-verification-token',
  trigger_id: 'trigger.test',
  container: { type: 'message', message_ts: lead.slackTs, channel_id: lead.slackChannel, is_ephemeral: false },
  channel: { id: lead.slackChannel, name: 'sales' },
  message: { type: 'message', ts: lead.slackTs, text: 'card' },
  response_url: 'https://hooks.slack.com/actions/T0TEST/test',
  actions: [{ type: 'button', action_id: actionId, block_id: `lead_actions_${String(lead.id)}`, value: String(lead.id), action_ts: '1.1' }],
});

export const messageShortcut = (input: { channel: string; ts: string; text: string; user: string }): Record<string, unknown> => ({
  type: 'message_action',
  callback_id: 'create_lead_from_message',
  trigger_id: 'trigger.test',
  message_ts: input.ts,
  response_url: 'https://hooks.slack.com/actions/T0TEST/test',
  message: { type: 'message', user: 'U0AUTHOR', ts: input.ts, text: input.text },
  user: { id: input.user, name: input.user, team_id: 'T0TEST' },
  channel: { id: input.channel, name: 'sales-leads' },
  team: { id: 'T0TEST', domain: 'test' },
  token: 'test-verification-token',
  action_ts: input.ts,
});
