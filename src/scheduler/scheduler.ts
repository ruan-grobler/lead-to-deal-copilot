import type { Logger } from '../logger.ts';
import { describeError } from '../reliability/errors.ts';

export interface ScheduledTask {
  name: string;
  run: () => Promise<unknown>;
}

export interface Scheduler {
  /** Runs every task once. Exposed so tests and the demo can drive time themselves. */
  tick: () => Promise<void>;
  stop: () => void;
}

/**
 * A plain interval loop. Each task decides for itself whether it is due
 * (reminders after two hours, the digest at 08:00 local time), so a missed
 * tick or a restart only delays work, it never skips or repeats it.
 */
export const startScheduler = (tasks: ScheduledTask[], tickMs: number, logger: Logger): Scheduler => {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      for (const task of tasks) {
        try {
          await task.run();
        } catch (error) {
          logger.error('scheduler.task_failed', { task: task.name, error: describeError(error) });
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, tickMs);
  timer.unref();
  return {
    tick,
    stop: () => {
      clearInterval(timer);
    },
  };
};
