import type { App, Receiver } from '@slack/bolt';

export interface InMemoryReceiver extends Receiver {
  /** Feeds a Slack interaction payload through Bolt, as Socket Mode would. Resolves after the listeners finish. */
  dispatch: (body: Record<string, unknown>) => Promise<void>;
}

/** A Bolt receiver with no network: the demo and the tests drive the real Bolt app through it. */
export const createInMemoryReceiver = (): InMemoryReceiver => {
  let bolt: App | null = null;
  return {
    init: (app) => {
      bolt = app;
    },
    start: async () => Promise.resolve(),
    stop: async () => Promise.resolve(),
    dispatch: async (body) => {
      if (!bolt) {
        throw new Error('Receiver is not attached to a Bolt app');
      }
      await bolt.processEvent({ body, ack: async () => Promise.resolve() });
    },
  };
};
