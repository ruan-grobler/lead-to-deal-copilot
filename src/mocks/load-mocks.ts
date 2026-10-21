import type { Logger } from '../logger.ts';
import type { DefaultMocks } from './default-mocks.ts';

/**
 * Loads the in-process mocks only in mock mode. msw is a dev dependency, so
 * a production install (npm ci --omit=dev, the Docker image) runs live mode
 * without it and never imports this code.
 */
export const loadDefaultMocks = async (logger: Logger, options: { allowRealClaude: boolean }): Promise<DefaultMocks> => {
  try {
    const { startDefaultMocks } = await import('./default-mocks.ts');
    return startDefaultMocks(logger, options);
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND';
    throw new Error(missing ? 'MODE=mock needs the dev dependencies (run npm install). The production image runs MODE=live only.' : String(error), { cause: error });
  }
};
