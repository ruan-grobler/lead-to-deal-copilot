import { http, HttpResponse, type HttpHandler } from 'msw';

/**
 * An in-memory Slack Web API, served through msw so the real @slack/web-api
 * client (and Bolt) run unchanged. It records every message so tests and the
 * demo can assert on what the sales channel would have seen.
 */

export interface MockSlackMessage {
  channel: string;
  ts: string;
  text: string;
  blocks: unknown[];
  threadTs: string | null;
  updates: number;
}

export interface MockSlackUser {
  id: string;
  name: string;
  email: string;
}

export interface SlackMock {
  handlers: HttpHandler[];
  messages: MockSlackMessage[];
  ephemerals: { channel: string; user: string; text: string }[];
  calls: { method: string; ok: boolean }[];
  addUser: (user: MockSlackUser) => void;
  /** The next `count` calls answer HTTP 429 with Retry-After. */
  rateLimitNext: (count: number, retryAfterSeconds?: number) => void;
  failNext: (count: number, status: number) => void;
  channelId: (name: string) => string;
  /** Top level messages (not thread replies) posted to a channel. */
  topLevel: (channelName: string) => MockSlackMessage[];
  threadReplies: (channelName: string) => MockSlackMessage[];
  reset: () => void;
}

const BOT = { user_id: 'U0MOCKBOT', bot_id: 'B0MOCKBOT', team_id: 'T0NORTHWIND', team: 'Northwind Managed IT (mock)' };

const parseBody = async (request: Request): Promise<Record<string, unknown>> => {
  const type = request.headers.get('content-type') ?? '';
  const raw = await request.text();
  if (type.includes('application/json')) {
    const parsed: unknown = JSON.parse(raw || '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  }
  const params = new URLSearchParams(raw);
  const result: Record<string, unknown> = {};
  for (const [key, value] of params) {
    result[key] = value;
  }
  return result;
};

const asString = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

const asBlocks = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value as unknown[];
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as unknown[]) : [];
  }
  return [];
};

export const createSlackMock = (): SlackMock => {
  const messages: MockSlackMessage[] = [];
  const ephemerals: { channel: string; user: string; text: string }[] = [];
  const calls: { method: string; ok: boolean }[] = [];
  const users = new Map<string, MockSlackUser>();
  const channels = new Map<string, string>();
  const pending: { status: number; retryAfter: number }[] = [];
  let tsCounter = 0;

  const channelId = (name: string): string => {
    if (/^[CGD][A-Z0-9]{6,}$/.test(name)) {
      return name;
    }
    const key = name.replace(/^#/, '').toLowerCase();
    let id = channels.get(key);
    if (!id) {
      id = `C0${key.replace(/[^a-z0-9]/g, '').toUpperCase().slice(0, 9).padEnd(7, 'X')}`;
      channels.set(key, id);
    }
    return id;
  };

  const nextTs = (): string => {
    tsCounter += 1;
    return `1760950000.${String(tsCounter).padStart(6, '0')}`;
  };

  const reply = (method: string, body: Record<string, unknown>): Response => {
    const ok = body.ok === true;
    calls.push({ method, ok });
    return HttpResponse.json(body);
  };

  const handlers: HttpHandler[] = [
    http.post('https://slack.com/api/:method', async ({ request, params }) => {
      const method = asString(params.method);
      const failure = pending.shift();
      if (failure) {
        calls.push({ method, ok: false });
        return failure.status === 429
          ? HttpResponse.json({ ok: false, error: 'ratelimited' }, { status: 429, headers: { 'retry-after': String(failure.retryAfter) } })
          : HttpResponse.json({ ok: false, error: 'internal_error' }, { status: failure.status });
      }
      const token = request.headers.get('authorization') ?? '';
      if (!token.startsWith('Bearer xoxb-')) {
        return reply(method, { ok: false, error: 'not_authed' });
      }
      const body = await parseBody(request);

      switch (method) {
        case 'auth.test':
          return reply(method, { ok: true, url: 'https://northwind-mock.slack.com/', ...BOT });
        case 'chat.postMessage': {
          const message: MockSlackMessage = {
            channel: channelId(asString(body.channel)),
            ts: nextTs(),
            text: asString(body.text),
            blocks: asBlocks(body.blocks),
            threadTs: asString(body.thread_ts) || null,
            updates: 0,
          };
          messages.push(message);
          return reply(method, { ok: true, channel: message.channel, ts: message.ts, message: { text: message.text, ts: message.ts } });
        }
        case 'chat.update': {
          const channel = channelId(asString(body.channel));
          const message = messages.find((item) => item.channel === channel && item.ts === asString(body.ts));
          if (!message) {
            return reply(method, { ok: false, error: 'message_not_found' });
          }
          message.text = asString(body.text);
          message.blocks = asBlocks(body.blocks);
          message.updates += 1;
          return reply(method, { ok: true, channel, ts: message.ts });
        }
        case 'chat.postEphemeral':
          ephemerals.push({ channel: channelId(asString(body.channel)), user: asString(body.user), text: asString(body.text) });
          return reply(method, { ok: true, message_ts: nextTs() });
        case 'users.info': {
          const user = users.get(asString(body.user));
          return user
            ? reply(method, { ok: true, user: { id: user.id, name: user.name, real_name: user.name, profile: { email: user.email, real_name: user.name } } })
            : reply(method, { ok: false, error: 'user_not_found' });
        }
        default:
          return reply(method, { ok: false, error: 'unknown_method' });
      }
    }),
  ];

  return {
    handlers,
    messages,
    ephemerals,
    calls,
    addUser: (user) => {
      users.set(user.id, user);
    },
    rateLimitNext: (count, retryAfterSeconds = 1) => {
      for (let index = 0; index < count; index += 1) {
        pending.push({ status: 429, retryAfter: retryAfterSeconds });
      }
    },
    failNext: (count, status) => {
      for (let index = 0; index < count; index += 1) {
        pending.push({ status, retryAfter: 0 });
      }
    },
    channelId,
    topLevel: (channelName) => messages.filter((message) => message.channel === channelId(channelName) && message.threadTs === null),
    threadReplies: (channelName) => messages.filter((message) => message.channel === channelId(channelName) && message.threadTs !== null),
    reset: () => {
      messages.length = 0;
      ephemerals.length = 0;
      calls.length = 0;
      users.clear();
      pending.length = 0;
      tsCounter = 0;
    },
  };
};
