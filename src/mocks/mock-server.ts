import type { HttpHandler } from 'msw';
import { setupServer, type SetupServer } from 'msw/node';

/**
 * Starts msw request interception for this process. Any request that no mock
 * handles fails loudly instead of reaching the internet, except hosts listed
 * in `passthroughHosts` (mock mode lets a real Claude key through on purpose).
 */
export const startMockServer = (handlers: HttpHandler[], options: { passthroughHosts?: string[] } = {}): SetupServer => {
  const server = setupServer(...handlers);
  const passthrough = new Set(options.passthroughHosts ?? []);
  server.listen({
    onUnhandledRequest: (request, print) => {
      if (passthrough.has(new URL(request.url).hostname)) {
        return;
      }
      print.error();
    },
  });
  return server;
};
