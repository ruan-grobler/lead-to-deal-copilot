import type { SetupServer } from 'msw/node';
import type { Logger } from '../logger.ts';
import { createHubSpotMock, type HubSpotMock } from './hubspot-mock.ts';
import { startMockServer } from './mock-server.ts';
import { createSlackMock, type SlackMock } from './slack-mock.ts';

export interface DefaultMocks {
  server: SetupServer;
  hubspot: HubSpotMock;
  slack: SlackMock;
}

/**
 * Mock mode for `npm start` and the CLIs: HubSpot and Slack answer
 * in-process. Claude is real only if ANTHROPIC_API_KEY is set; otherwise AI
 * is off and every lead goes through the fallback rules to human review.
 */
export const startDefaultMocks = (logger: Logger, options: { allowRealClaude: boolean }): DefaultMocks => {
  const hubspot = createHubSpotMock();
  const slack = createSlackMock();
  const server = startMockServer([...hubspot.handlers, ...slack.handlers], {
    passthroughHosts: options.allowRealClaude ? ['api.anthropic.com'] : [],
  });
  server.events.on('response:mocked', ({ request, response }) => {
    const url = new URL(request.url);
    if (url.hostname === 'slack.com' && url.pathname.endsWith('chat.postMessage')) {
      const last = slack.messages.at(-1);
      logger.info('mock.slack.message', { channel: last?.channel, thread: last?.threadTs, text: last?.text });
    } else {
      logger.debug('mock.response', { method: request.method, path: url.pathname, status: response.status });
    }
  });
  return { server, hubspot, slack };
};
