import { loadConfig } from '../config.ts';
import { createLogger } from '../logger.ts';
import { startDefaultMocks, type DefaultMocks } from '../mocks/default-mocks.ts';
import { createRuntime, type Runtime } from '../runtime.ts';
import { createInMemoryReceiver } from '../slack/in-memory-receiver.ts';

export interface CliContext {
  runtime: Runtime;
  mocks: DefaultMocks | null;
  close: () => Promise<void>;
}

/** Same wiring as the server, without listening on a port or opening a Slack socket. */
export const bootstrapCli = (): CliContext => {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel === 'info' ? 'warn' : config.logLevel });
  const mocks = config.mode === 'mock' ? startDefaultMocks(logger, { allowRealClaude: config.ai.apiKey !== null }) : null;
  const runtime = createRuntime({ config, logger, slackReceiver: createInMemoryReceiver() });
  return {
    runtime,
    mocks,
    close: async () => {
      await runtime.stop();
      mocks?.server.close();
    },
  };
};

export const print = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};
