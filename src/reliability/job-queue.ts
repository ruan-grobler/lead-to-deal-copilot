export type Job = () => Promise<void>;

export interface JobQueue {
  push: (job: Job) => void;
  /** Resolves when nothing is queued or running. */
  onIdle: () => Promise<void>;
  size: () => number;
  running: () => number;
}

/**
 * In-process FIFO work queue. Webhooks persist the lead first, answer 202,
 * then push the processing here. A crash mid-job leaves the lead in
 * `processing`, which the next start moves to the dead letter table.
 */
export const createJobQueue = (concurrency: number, onError: (error: unknown) => void): JobQueue => {
  const queue: Job[] = [];
  let active = 0;
  let idleWaiters: (() => void)[] = [];

  const notifyIfIdle = (): void => {
    if (active === 0 && queue.length === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
  };

  const pump = (): void => {
    while (active < concurrency && queue.length > 0) {
      const job = queue.shift();
      if (!job) {
        break;
      }
      active += 1;
      void (async (): Promise<void> => {
        try {
          await job();
        } catch (error) {
          onError(error);
        } finally {
          active -= 1;
          pump();
          notifyIfIdle();
        }
      })();
    }
  };

  return {
    push: (job) => {
      queue.push(job);
      // Start on the next turn of the event loop, so a webhook's 202 is written before work begins.
      setImmediate(pump);
    },
    onIdle: async () => {
      if (active === 0 && queue.length === 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    size: () => queue.length,
    running: () => active,
  };
};
