import { App, LogLevel, type Logger as SlackLogger, type Receiver } from '@slack/bolt';
import type { WebClientOptions } from '@slack/web-api';
import type { Clock } from '../clock.ts';
import type { Logger } from '../logger.ts';
import type { LeadActions } from '../pipeline/actions.ts';
import type { LeadProcessor } from '../pipeline/processor.ts';
import { describeError } from '../reliability/errors.ts';
import type { JobQueue } from '../reliability/job-queue.ts';
import { slackMessageToLead } from '../sources/slack-message.ts';
import { ACTION_IDS, SHORTCUT_CALLBACK_ID } from './blocks.ts';
import type { SlackNotifier } from './notifier.ts';

export interface SlackAppDeps {
  botToken: string;
  /** Socket Mode app token (xapp-...). Used when no custom receiver is given. */
  appToken: string | null;
  /** Tests and the demo pass an in-memory receiver instead of opening a socket. */
  receiver: Receiver | null;
  /** Known bot identity skips the auth.test call. Mock mode only. */
  botIdentity: { botId: string; botUserId: string } | null;
  clientOptions: WebClientOptions;
  logger: Logger;
  clock: Clock;
  processor: LeadProcessor;
  queue: JobQueue;
  actions: LeadActions;
  notifier: SlackNotifier;
}

/** Bolt logs through our JSON logger, so everything stays one log format. */
export const boltLogger = (logger: Logger): SlackLogger => {
  let level: LogLevel = LogLevel.INFO;
  const join = (parts: unknown[]): string => parts.map((part) => (typeof part === 'string' ? part : describeError(part))).join(' ');
  return {
    debug: (...msg: unknown[]) => {
      logger.debug('bolt', { detail: join(msg) });
    },
    info: (...msg: unknown[]) => {
      logger.info('bolt', { detail: join(msg) });
    },
    warn: (...msg: unknown[]) => {
      logger.warn('bolt', { detail: join(msg) });
    },
    error: (...msg: unknown[]) => {
      logger.error('bolt', { detail: join(msg) });
    },
    setLevel: (next: LogLevel) => {
      level = next;
    },
    getLevel: () => level,
    setName: () => undefined,
  };
};

const leadIdFrom = (value: string | undefined): number | null => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export const createSlackApp = (deps: SlackAppDeps): App => {
  const app = new App({
    token: deps.botToken,
    ...(deps.receiver ? { receiver: deps.receiver } : { socketMode: true, appToken: deps.appToken ?? '' }),
    ...(deps.botIdentity ?? {}),
    logger: boltLogger(deps.logger),
    clientOptions: deps.clientOptions,
  });

  const replyPrivately = async (channel: string | undefined, user: string, text: string): Promise<void> => {
    if (!channel) {
      return;
    }
    try {
      await deps.notifier.postEphemeral(channel, user, text);
    } catch (error) {
      deps.logger.warn('slack.ephemeral_failed', { error: describeError(error) });
    }
  };

  // Message shortcut: "Create lead from message".
  app.shortcut(SHORTCUT_CALLBACK_ID, async ({ shortcut, ack }) => {
    await ack();
    if (shortcut.type !== 'message_action') {
      return;
    }
    const lead = slackMessageToLead(
      {
        teamId: shortcut.team?.id ?? shortcut.user.team_id ?? 'unknown',
        channelId: shortcut.channel.id,
        messageTs: shortcut.message.ts,
        text: shortcut.message.text ?? '',
        authorUserId: shortcut.message.user ?? null,
        sharedByUserId: shortcut.user.id,
      },
      deps.clock.now(),
    );
    const outcome = deps.processor.ingest(lead);
    if (!outcome.duplicate) {
      deps.queue.push(async () => {
        await deps.processor.process(outcome.leadId);
      });
    }
    await replyPrivately(
      shortcut.channel.id,
      shortcut.user.id,
      outcome.duplicate
        ? `This message is already lead ${String(outcome.leadId)}, so nothing new was created.`
        : `Captured as lead ${String(outcome.leadId)}. The card will appear in the sales channel in a moment.`,
    );
  });

  const registerButton = (actionId: string, run: (leadId: number, userId: string) => ReturnType<LeadActions['approve']>): void => {
    app.action(actionId, async ({ ack, body, action }) => {
      await ack();
      if (body.type !== 'block_actions' || action.type !== 'button') {
        return;
      }
      const leadId = leadIdFrom(action.value);
      if (leadId === null) {
        deps.logger.warn('slack.action_without_lead', { actionId });
        return;
      }
      const outcome = await run(leadId, body.user.id);
      if (!outcome.ok || actionId === ACTION_IDS.assign) {
        await replyPrivately(body.channel?.id, body.user.id, outcome.message);
      }
    });
  };

  registerButton(ACTION_IDS.approve, deps.actions.approve);
  registerButton(ACTION_IDS.assign, deps.actions.assign);
  registerButton(ACTION_IDS.notAFit, deps.actions.notAFit);

  app.error(async (error) => {
    deps.logger.error('slack.unhandled', { error: describeError(error) });
    return Promise.resolve();
  });

  return app;
};
