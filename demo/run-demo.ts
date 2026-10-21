import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeClock, MINUTE_MS } from '../src/clock.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import type { LeadRow } from '../src/db/repository.ts';
import type { FallbackReason } from '../src/domain/types.ts';
import { signBody, SIGNATURE_HEADER } from '../src/http/signature.ts';
import { createLogger } from '../src/logger.ts';
import { createAnthropicMock, type AnthropicBehavior } from '../src/mocks/anthropic-mock.ts';
import { createHubSpotMock, type HubSpotMock } from '../src/mocks/hubspot-mock.ts';
import { startMockServer } from '../src/mocks/mock-server.ts';
import { createSlackMock, type MockSlackMessage } from '../src/mocks/slack-mock.ts';
import { replayDeadLetters, type ReplaySummary } from '../src/pipeline/dead-letter.ts';
import { FALLBACK_LABELS } from '../src/pipeline/labels.ts';
import { slackIdempotencyKey } from '../src/reliability/idempotency.ts';
import { seededRandom } from '../src/reliability/retry.ts';
import { createRuntime } from '../src/runtime.ts';
import { localTimeLabel } from '../src/scheduler/time.ts';
import { ACTION_IDS, SHORTCUT_CALLBACK_ID } from '../src/slack/blocks.ts';
import { createInMemoryReceiver } from '../src/slack/in-memory-receiver.ts';
import { CLICKS, SALES_TEAM, SCENARIOS, seedCrm, TEAM_ID, type DemoScenario } from './scenarios.ts';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'email');
const SCENARIO_START = new Date('2026-10-20T07:00:00.000Z'); // Tue 20 Oct 2026, 09:00 in Cape Town
const DIGEST_MORNING = new Date('2026-10-21T06:00:00.000Z'); // Wed 21 Oct 2026, 08:00 in Cape Town
const TZ = 'Africa/Johannesburg';
const WEBHOOK_SECRET = 'demo-signing-secret-not-a-real-credential';

/** Shorter waits than live mode so the demo runs in seconds. The output states both. */
export const DEMO_RETRY: AppConfig['retry'] = {
  hubspot: { maxAttempts: 5, baseDelayMs: 40, maxDelayMs: 640, maxRetryAfterMs: 2_000, retryOnTimeout: true },
  slack: { maxAttempts: 4, baseDelayMs: 40, maxDelayMs: 400, maxRetryAfterMs: 2_000, retryOnTimeout: true },
  ai: { maxAttempts: 2, baseDelayMs: 50, maxDelayMs: 200, maxRetryAfterMs: 1_000, retryOnTimeout: false },
};

export interface DemoRow {
  index: number;
  scenario: DemoScenario;
  time: string;
  leadId: number;
  duplicate: boolean;
  statusAfterFirstPass: string;
  latencyMs: number | null;
  webhookMs: number | null;
  retries: number;
  lead: LeadRow;
}

export interface DemoCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DemoResult {
  realRunAt: string;
  nodeVersion: string;
  rows: DemoRow[];
  replay: ReplaySummary;
  clickLines: string[];
  reminderLines: string[];
  digestLines: string[];
  summary: [string, string][];
  checks: DemoCheck[];
  logLines: string[];
  numbers: DemoNumbers;
  slackMessages: MockSlackMessage[];
  hubspotObjects: HubSpotMock['objects'];
}

export interface DemoNumbers {
  inbound: number;
  unique: number;
  duplicatesBlocked: number;
  merged: number;
  existingContact: number;
  existingCompany: number;
  autoDrafted: number;
  humanReview: number;
  spam: number;
  support: number;
  aiFallback: number;
  aiCalls: number;
  hubspot429: number;
  retries: number;
  deadLettered: number;
  replayed: number;
  replaySucceeded: number;
  deadLettersPending: number;
  dealsCreated: number;
  duplicateDeals: number;
  lost: number;
  p50: number;
  p95: number;
  webhookP50: number;
  webhookP95: number;
  reminders: number;
  cards: number;
}

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

const pad = (value: string, width: number): string => (value.length >= width ? value : value + ' '.repeat(width - value.length));
const padLeft = (value: string, width: number): string => (value.length >= width ? value : ' '.repeat(width - value.length) + value);

const messageActionBody = (scenario: DemoScenario): Record<string, unknown> => {
  if (scenario.inbound.kind !== 'slack') {
    throw new Error(`${scenario.id} is not a Slack scenario`);
  }
  const { channel, channelName, ts, author, sharedBy, text } = scenario.inbound;
  return {
    type: 'message_action',
    callback_id: SHORTCUT_CALLBACK_ID,
    trigger_id: `trigger.${scenario.id}`,
    message_ts: ts,
    response_url: 'https://hooks.slack.com/actions/T0NORTHWIND/mock',
    message: { type: 'message', user: author, ts, text },
    user: { id: sharedBy, name: sharedBy.toLowerCase(), team_id: TEAM_ID },
    channel: { id: channel, name: channelName },
    team: { id: TEAM_ID, domain: 'northwind-mock' },
    token: 'mock-verification-token',
    action_ts: ts,
  };
};

const blockActionBody = (lead: LeadRow, actionId: string, user: string): Record<string, unknown> => ({
  type: 'block_actions',
  team: { id: TEAM_ID, domain: 'northwind-mock' },
  user: { id: user, username: user.toLowerCase(), name: user.toLowerCase(), team_id: TEAM_ID },
  api_app_id: 'A0MOCKAPP',
  token: 'mock-verification-token',
  trigger_id: `trigger.${String(lead.id)}.${actionId}`,
  container: { type: 'message', message_ts: lead.slackTs, channel_id: lead.slackChannel, is_ephemeral: false },
  channel: { id: lead.slackChannel, name: 'sales' },
  message: { type: 'message', ts: lead.slackTs, text: 'lead card' },
  response_url: 'https://hooks.slack.com/actions/T0NORTHWIND/mock',
  actions: [{ type: 'button', action_id: actionId, block_id: `lead_actions_${String(lead.id)}`, value: String(lead.id), action_ts: '1760950000.000001' }],
});

const resultText = (row: DemoRow): string => {
  const { lead } = row;
  if (row.duplicate) {
    return `replay blocked, already lead ${String(row.leadId)}`;
  }
  const fallback = lead.decision?.fallbackReason;
  const retries = row.retries > 0 ? ` after ${String(row.retries)} retr${row.retries === 1 ? 'y' : 'ies'}` : '';
  switch (row.statusAfterFirstPass) {
    case 'drafted':
      return `auto drafted${retries}, new deal ${lead.dealId ?? '?'}${lead.priority ? ', HIGH VALUE' : ''}${lead.dedupeMatch === 'contact_email' ? ', existing contact' : ''}`;
    case 'merged':
      return `merged into deal ${lead.mergedIntoDealId ?? '?'} (${lead.dedupeMatch === 'company_domain' ? 'company domain' : 'contact email'})`;
    case 'needs_review':
      return `human review: ${fallback ? fallback.replace('_', ' ') : 'parse warning'}${lead.inbound.parseWarnings.length > 0 ? ' + bad sender' : ''}`;
    case 'spam':
      return 'spam filtered, no CRM write';
    case 'support':
      return 'support request, sent to #support';
    case 'dead_lettered':
      return `dead lettered after ${String(row.retries + 1)} attempts`;
    default:
      return row.statusAfterFirstPass;
  }
};

export const runDemo = async (): Promise<DemoResult> => {
  const clock = createFakeClock(SCENARIO_START);
  const logLines: string[] = [];
  const logger = createLogger({ level: 'info', now: () => clock.now(), write: (line) => logLines.push(line) });

  const byFingerprint = SCENARIOS.filter((scenario) => scenario.fingerprint !== null && scenario.ai !== null);
  const anthropic = createAnthropicMock((userText): AnthropicBehavior => {
    const match = byFingerprint.find((scenario) => userText.includes(scenario.fingerprint ?? '\u0000'));
    return match?.ai ?? { kind: 'http_error', status: 500, errorType: 'api_error', message: 'No canned answer for this message' };
  });
  const hubspot = createHubSpotMock({ now: () => clock.now() });
  const slack = createSlackMock();
  const server = startMockServer([...anthropic.handlers, ...hubspot.handlers, ...slack.handlers], { passthroughHosts: ['127.0.0.1'] });
  seedCrm(hubspot);
  for (const user of SALES_TEAM) {
    slack.addUser(user);
  }

  const config: AppConfig = {
    ...loadConfig({
      MODE: 'mock',
      HOST: '127.0.0.1',
      PORT: '0',
      ANTHROPIC_API_KEY: 'mock-anthropic-key',
      AI_TIMEOUT_MS: '800',
      QUEUE_CONCURRENCY: '1',
      SLACK_SALES_LEAD_USER_ID: 'U0AMAHLE',
      FORM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      SCHEDULER_TICK_SECONDS: '86400',
    }),
    retry: DEMO_RETRY,
  };
  const receiver = createInMemoryReceiver();
  const runtime = createRuntime({
    config,
    logger,
    clock,
    databasePath: ':memory:',
    slackReceiver: receiver,
    retryDeps: { random: seededRandom(20261020) },
  });
  const { port } = await runtime.start();
  const base = `http://127.0.0.1:${String(port)}`;

  const rows: DemoRow[] = [];
  const seen = new Set<number>();
  try {
    for (const [index, scenario] of SCENARIOS.entries()) {
      clock.set(new Date(SCENARIO_START.getTime() + index * 10 * MINUTE_MS));
      if (scenario.hubspotStormBefore) {
        hubspot.startRateLimitStorm(scenario.hubspotStormBefore);
      }
      const retriesBefore = runtime.metrics.get('retry.scheduled');
      let leadId: number;
      let webhookMs: number | null = null;
      const started = performance.now();
      if (scenario.inbound.kind === 'form') {
        const body = JSON.stringify(scenario.inbound.payload);
        const response = await fetch(`${base}/webhooks/form`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signBody(WEBHOOK_SECRET, body) },
          body,
        });
        webhookMs = performance.now() - started;
        leadId = ((await response.json()) as { leadId: number }).leadId;
      } else if (scenario.inbound.kind === 'email') {
        const response = await fetch(`${base}/webhooks/email`, {
          method: 'POST',
          headers: { 'content-type': 'message/rfc822' },
          body: readFileSync(join(FIXTURES, scenario.inbound.file)),
        });
        webhookMs = performance.now() - started;
        leadId = ((await response.json()) as { leadId: number }).leadId;
      } else {
        await receiver.dispatch(messageActionBody(scenario));
        const lead = runtime.repo.getLeadByKey(slackIdempotencyKey(TEAM_ID, scenario.inbound.channel, scenario.inbound.ts));
        if (!lead) {
          throw new Error(`${scenario.id}: the Slack shortcut created no lead`);
        }
        leadId = lead.id;
      }
      await runtime.queue.onIdle();
      const lead = runtime.repo.getLead(leadId);
      if (!lead) {
        throw new Error(`${scenario.id}: lead ${String(leadId)} not found`);
      }
      const duplicate = seen.has(leadId);
      seen.add(leadId);
      rows.push({
        index: index + 1,
        scenario,
        time: localTimeLabel(clock.now(), TZ),
        leadId,
        duplicate,
        statusAfterFirstPass: duplicate ? 'duplicate' : lead.status,
        latencyMs: duplicate ? null : lead.latencyMs,
        webhookMs,
        retries: runtime.metrics.get('retry.scheduled') - retriesBefore,
        lead,
      });
    }

    // The same function `npm run replay` calls.
    clock.advance(5 * MINUTE_MS);
    const replay = await replayDeadLetters(runtime);

    // People click the buttons on the cards, through the real Bolt app.
    clock.advance(5 * MINUTE_MS);
    const clickLines: string[] = [];
    const clickResults: boolean[] = [];
    for (const click of CLICKS) {
      const row = rows.find((item) => item.scenario.id === click.scenarioId && !item.duplicate);
      const lead = row ? runtime.repo.getLead(row.leadId) : null;
      if (!lead) {
        throw new Error(`Click on unknown scenario ${click.scenarioId}`);
      }
      const ephemeralsBefore = slack.ephemerals.length;
      await receiver.dispatch(blockActionBody(lead, ACTION_IDS[click.action], click.user));
      const after = runtime.repo.getLead(lead.id);
      const reply = slack.ephemerals.slice(ephemeralsBefore).map((item) => item.text).join(' ');
      const person = SALES_TEAM.find((user) => user.id === click.user)?.name.split(' ')[0] ?? click.user;
      const name = after?.decision?.extraction.company.value ?? after?.decision?.extraction.name.value ?? `lead ${String(lead.id)}`;
      let effect: string;
      let ok: boolean;
      if (click.action === 'approve') {
        ok = after?.status === 'approved' && after.decidedBy === click.user;
        const dealId = after?.dealId ?? '?';
        effect = ok
          ? lead.route === 'human_review'
            ? `reviewed lead approved, contact, company and deal ${dealId} created in ${config.hubspot.stages.approved}`
            : `deal ${dealId} moved to ${config.hubspot.stages.approved}`
          : `refused: ${reply.replace(/<@(\w+)>/g, '$1')}`;
      } else if (click.action === 'assign') {
        ok = after?.assignedTo === click.user;
        const owner = after?.dealId ? hubspot.objects.deals.get(after.dealId)?.properties.hubspot_owner_id : null;
        effect = ok ? `assigned, HubSpot deal owner set to ${owner ?? 'nobody'}` : 'assignment failed';
      } else {
        ok = after?.status === 'not_a_fit';
        effect = ok ? 'closed as not a fit, no CRM write (it was never drafted)' : 'failed';
      }
      clickResults.push(ok === click.expectOk);
      clickLines.push(`${localTimeLabel(clock.now(), TZ)}  ${pad(person, 7)} ${pad(click.action === 'notAFit' ? 'not a fit' : click.action === 'assign' ? 'assign to me' : 'approve', 12)} lead ${padLeft(String(lead.id), 2)} ${pad(name, 26)} ${effect}`);
    }

    // Two hours later the reminder sweep runs.
    clock.advance(125 * MINUTE_MS);
    const firstSweep = await runtime.runReminders();
    const secondSweep = await runtime.runReminders();
    const reminderLines = [
      `${localTimeLabel(clock.now(), TZ)}  reminder sweep (threshold ${String(config.remindAfterMinutes)} min): ${String(firstSweep.reminded)} threaded reminders on untouched cards`,
      `${localTimeLabel(clock.now(), TZ)}  same sweep again: ${String(secondSweep.reminded)} reminders (each card is reminded once)`,
    ];

    // The next morning: not before 08:00 Cape Town time, then exactly once.
    clock.set(new Date(DIGEST_MORNING.getTime() - MINUTE_MS));
    const early = await runtime.runDigest();
    clock.set(DIGEST_MORNING);
    const digest = await runtime.runDigest();
    const again = await runtime.runDigest();
    const digestMessage = slack.messages.filter((message) => message.text.startsWith('Lead digest')).at(-1);
    const digestLines = [
      `Wed 07:59  digest due? ${early.posted ? 'posted (wrong)' : 'no, not before 08:00 Africa/Johannesburg'}`,
      `Wed 08:00  digest ${digest.posted ? 'posted to #sales' : 'NOT posted'}: "${digestMessage?.text ?? ''}"`,
      `Wed 08:00  second run the same day: ${again.posted ? 'posted again (wrong)' : 'skipped, already posted'}`,
    ];

    await runtime.queue.onIdle();
    const leads = runtime.repo.listLeads();
    const final = new Map(leads.map((lead) => [lead.id, lead]));
    const unique = rows.filter((row) => !row.duplicate);
    const finished = new Set(['drafted', 'merged', 'needs_review', 'support', 'spam', 'approved', 'not_a_fit']);
    const lost = leads.filter((lead) => !finished.has(lead.status));
    const fallbacks = leads.map((lead) => lead.decision?.fallbackReason).filter((reason): reason is FallbackReason => typeof reason === 'string');
    const fallbackBreakdown = [...new Set(fallbacks)].map((reason) => `${reason.replace('_', ' ')} ${String(fallbacks.filter((item) => item === reason).length)}`).join(', ');
    const copilotDeals = [...hubspot.objects.deals.values()].filter((deal) => deal.properties.description?.includes('Lead to Deal Copilot') === true);
    const leadDealIds = new Set(leads.filter((lead) => lead.dealId !== null && lead.mergedIntoDealId === null).map((lead) => lead.dealId));
    const contactsWithTwoOpenDeals = [...hubspot.objects.contacts.keys()].filter(
      (contactId) => hubspot.associationsOf('contacts', contactId, 'deals').filter((dealId) => hubspot.objects.deals.get(dealId)?.properties.hs_is_closed !== 'true').length > 1,
    ).length;
    const latencies = unique.map((row) => row.latencyMs ?? 0);
    const webhookTimes = rows.map((row) => row.webhookMs).filter((value): value is number => value !== null);
    const salesTop = slack.topLevel('#sales').length;
    const threaded = slack.messages.filter((message) => message.threadTs !== null).length;

    const numbers: DemoNumbers = {
      inbound: rows.length,
      unique: leads.length,
      duplicatesBlocked: leads.reduce((total, lead) => total + lead.duplicateHits, 0),
      merged: leads.filter((lead) => lead.mergedIntoDealId !== null).length,
      existingContact: leads.filter((lead) => lead.dedupeMatch === 'contact_email').length,
      existingCompany: leads.filter((lead) => lead.dedupeMatch === 'company_domain').length,
      autoDrafted: leads.filter((lead) => lead.route === 'auto_draft' && lead.mergedIntoDealId === null).length,
      humanReview: leads.filter((lead) => lead.route === 'human_review').length,
      spam: leads.filter((lead) => lead.route === 'spam').length,
      support: leads.filter((lead) => lead.route === 'support').length,
      aiFallback: fallbacks.length,
      aiCalls: anthropic.calls.length,
      hubspot429: hubspot.served(429),
      retries: runtime.metrics.get('retry.scheduled'),
      deadLettered: runtime.repo.listDeadLetters().length,
      replayed: replay.attempted,
      replaySucceeded: replay.succeeded,
      deadLettersPending: runtime.repo.countPendingDeadLetters(),
      dealsCreated: copilotDeals.length,
      duplicateDeals: copilotDeals.length - leadDealIds.size + contactsWithTwoOpenDeals,
      lost: lost.length,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      webhookP50: percentile(webhookTimes, 50),
      webhookP95: percentile(webhookTimes, 95),
      reminders: firstSweep.reminded,
      cards: salesTop,
    };

    const summary: [string, string][] = [
      ['Inbound messages', `${String(numbers.inbound)}  (15 web form, 8 email, 2 Slack shortcut)`],
      ['Processed as unique leads', String(numbers.unique)],
      ['Replays blocked by idempotency key', `${String(numbers.duplicatesBlocked)}  (form retry, email redelivery, Slack shortcut clicked twice)`],
      ['Deduplicated against HubSpot', `${String(numbers.existingContact + numbers.existingCompany)}  (${String(numbers.existingContact)} by contact email, ${String(numbers.existingCompany)} by company domain)`],
      ['  of which merged into an open deal', `${String(numbers.merged)}  (note added, no second deal)`],
      ['Auto drafted deals', String(numbers.autoDrafted)],
      ['Sent to human review', String(numbers.humanReview)],
      ['Spam filtered', String(numbers.spam)],
      ['Support requests routed', String(numbers.support)],
      ['AI fallback used', `${String(numbers.aiFallback)}  (${fallbackBreakdown})`],
      ['Claude API calls (mocked)', String(numbers.aiCalls)],
      ['HubSpot 429 responses served', String(numbers.hubspot429)],
      ['Retries scheduled (backoff + jitter)', String(numbers.retries)],
      ['Dead lettered', String(numbers.deadLettered)],
      ['Replayed from dead letter', `${String(numbers.replayed)}  (${String(numbers.replaySucceeded)} succeeded, ${String(numbers.replayed - numbers.replaySucceeded)} failed)`],
      ['Deals created in HubSpot', String(numbers.dealsCreated)],
      ['Duplicate deals', String(numbers.duplicateDeals)],
      ['Leads lost', String(numbers.lost)],
      ['Processing latency p50 / p95', `${String(numbers.p50)} ms / ${String(numbers.p95)} ms  (pipeline time per unique lead, first pass)`],
      ['Webhook response p50 / p95', `${numbers.webhookP50.toFixed(1)} ms / ${numbers.webhookP95.toFixed(1)} ms  (time to the 202, ${String(webhookTimes.length)} HTTP deliveries)`],
      ['Slack messages', `${String(salesTop)} in #sales, ${String(threaded)} thread replies, ${String(slack.topLevel('#support').length)} in #support, ${String(slack.topLevel('#sales-ops').length)} alerts in #sales-ops`],
      ['Structured JSON log lines', String(logLines.length)],
    ];

    const checks: DemoCheck[] = [];
    const expectedFinal = (scenario: DemoScenario): string => scenario.expect.afterReplay ?? scenario.expect.outcome;
    const mismatches = rows.filter((row) => {
      const expected = row.scenario.expect;
      if (expected.outcome === 'duplicate') {
        return !row.duplicate;
      }
      const lead = final.get(row.leadId);
      const fallbackOk = expected.fallback === undefined || lead?.decision?.fallbackReason === expected.fallback;
      const priorityOk = expected.priority === undefined || lead?.priority === expected.priority;
      const dedupeOk = expected.dedupe === undefined || lead?.dedupeMatch === expected.dedupe;
      return row.statusAfterFirstPass !== expected.outcome || !fallbackOk || !priorityOk || !dedupeOk || lead === undefined || (expectedFinal(row.scenario) === 'drafted' && lead.route !== 'auto_draft');
    });
    checks.push({ name: 'Every scenario ended as expected', ok: mismatches.length === 0, detail: mismatches.length === 0 ? `${String(rows.length)} of ${String(rows.length)}` : `mismatch: ${mismatches.map((row) => row.scenario.id).join(', ')}` });
    checks.push({ name: 'No lead lost', ok: lost.length === 0, detail: `${String(leads.length - lost.length)} of ${String(leads.length)} unique leads in a final state` });
    checks.push({ name: 'No duplicate deals', ok: numbers.duplicateDeals === 0, detail: `${String(copilotDeals.length)} deals for ${String(leadDealIds.size)} drafted leads, ${String(contactsWithTwoOpenDeals)} contacts with two open deals` });
    checks.push({ name: 'Dead letter table empty after replay', ok: numbers.deadLettersPending === 0, detail: `${String(numbers.deadLettersPending)} pending` });
    checks.push({ name: 'Slack clicks behaved, double approve refused', ok: clickResults.every(Boolean), detail: `${String(clickResults.filter(Boolean).length)} of ${String(clickResults.length)}` });
    checks.push({ name: 'Reminders sent once per card', ok: firstSweep.reminded > 0 && secondSweep.reminded === 0, detail: `${String(firstSweep.reminded)} then ${String(secondSweep.reminded)}` });
    checks.push({ name: 'Digest at 08:00 Africa/Johannesburg, once', ok: !early.posted && digest.posted && !again.posted, detail: `07:59 ${early.posted ? 'posted' : 'skipped'}, 08:00 ${digest.posted ? 'posted' : 'skipped'}, rerun ${again.posted ? 'posted' : 'skipped'}` });

    return {
      realRunAt: new Date().toISOString(),
      nodeVersion: process.version,
      rows,
      replay,
      clickLines,
      reminderLines,
      digestLines,
      summary,
      checks,
      logLines,
      numbers,
      slackMessages: slack.messages,
      hubspotObjects: hubspot.objects,
    };
  } finally {
    await runtime.stop();
    server.close();
  }
};

export const formatReport = (result: DemoResult): string => {
  const out: string[] = [];
  const line = (text = ''): void => {
    out.push(text);
  };
  line('Lead to Deal Copilot: demo run');
  line('==============================');
  line('Synthetic data only. Northwind Managed IT is a fictional Cape Town IT services firm, and every');
  line('person, company, email address (example.com) and phone number (+27 00) below is invented.');
  line('Slack, HubSpot and Claude are mocked in-process with msw, so nothing leaves this machine.');
  line('The Claude mock returns a canned answer per scenario. Everything around it is the real code:');
  line('the HTTP webhooks, Bolt, the HubSpot and Anthropic SDKs, SQLite, retries and the dead letter replay.');
  line(`Scenario clock: Tue 20 Oct 2026 from 09:00 Africa/Johannesburg (fake). Real run: ${result.realRunAt}, Node ${result.nodeVersion}.`);
  line('Demo timings: AI timeout 800 ms (live 20 s). HubSpot backoff 40 ms base, 640 ms cap, 5 attempts');
  line('(live 500 ms, 8 s, 6 attempts). Latencies are measured against local mocks, so real network and');
  line('model time are not included.');
  line();
  line(' #  Time   Source  Scenario                                       Result                                              ms');
  for (const row of result.rows) {
    const ms = row.latencyMs === null ? '-' : String(row.latencyMs);
    line(`${padLeft(String(row.index), 2)}  ${row.time}  ${pad(row.scenario.inbound.kind, 6)}  ${pad(`${row.scenario.id} ${row.scenario.label}`, 45)}  ${pad(resultText(row), 50)}  ${padLeft(ms, 4)}`);
  }
  line();
  line('Dead letter replay (the same function npm run replay calls)');
  for (const item of result.replay.results) {
    const lead = item.result;
    line(`  entry ${String(item.deadLetter.id)}, lead ${String(item.deadLetter.leadId)}: failed at ${item.deadLetter.stage} (HTTP ${String(item.deadLetter.httpStatus ?? '-')}, ${String(item.deadLetter.attempts)} attempts), replay ${lead.status === 'dead_lettered' ? 'failed again' : `ok, ${lead.status}`}`);
  }
  line();
  line('Slack button clicks, sent through Bolt with an in-memory receiver');
  for (const text of result.clickLines) {
    line(`  ${text}`);
  }
  line();
  line('Scheduled jobs');
  for (const text of [...result.reminderLines, ...result.digestLines]) {
    line(`  ${text}`);
  }
  line();
  line('Summary');
  for (const [label, value] of result.summary) {
    line(`  ${pad(label, 38)} ${value}`);
  }
  line();
  line('Self checks');
  for (const check of result.checks) {
    line(`  [${check.ok ? 'PASS' : 'FAIL'}] ${pad(check.name, 46)} ${check.detail}`);
  }
  line();
  line('Fallback reasons used in this run');
  const reasons = new Set(result.rows.map((row) => row.lead.decision?.fallbackReason).filter((reason): reason is FallbackReason => typeof reason === 'string'));
  for (const reason of reasons) {
    line(`  ${pad(reason, 15)} ${FALLBACK_LABELS[reason]}`);
  }
  line();
  const sample = result.logLines.find((entry) => entry.includes('"lead.processed"') && entry.includes('"leadId":1,'));
  line('Sample structured log line');
  line(`  ${sample ?? result.logLines[0] ?? ''}`);
  return `${out.join('\n')}\n`;
};
