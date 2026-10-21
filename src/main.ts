import { ConfigError, loadConfig } from './config.ts';
import { createLogger } from './logger.ts';
import { loadDefaultMocks } from './mocks/load-mocks.ts';
import { createRuntime } from './runtime.ts';
import { createInMemoryReceiver } from './slack/in-memory-receiver.ts';
import { nextDailyRun } from './scheduler/time.ts';

/**
 * `npm start`. MODE=mock (the default) keeps everything on this machine:
 * HubSpot and Slack are answered in-process. MODE=live talks to the real
 * services with the tokens from .env (see docs/live-setup.md).
 */
const main = async (): Promise<void> => {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const mocks = config.mode === 'mock' ? await loadDefaultMocks(logger, { allowRealClaude: config.ai.apiKey !== null }) : null;
  const runtime = createRuntime({ config, logger, ...(mocks ? { slackReceiver: createInMemoryReceiver() } : {}) });
  const { port } = await runtime.start();
  logger.info('server.started', {
    mode: config.mode,
    url: `http://${config.http.host}:${String(port)}`,
    endpoints: ['GET /health', 'POST /webhooks/form', 'POST /webhooks/email'],
    slack: mocks ? 'mocked, no Socket Mode connection' : 'Socket Mode',
    nextDigest: nextDailyRun(new Date(), config.digest).toISOString(),
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info('server.stopping', { signal });
    void runtime
      .stop()
      .then(() => {
        mocks?.server.close();
        logger.info('server.stopped');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error('server.stop_failed', { error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
      });
  };
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
};

main().catch((error: unknown) => {
  const message = error instanceof ConfigError ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'server.failed_to_start', error: message })}\n`);
  process.exit(1);
});
