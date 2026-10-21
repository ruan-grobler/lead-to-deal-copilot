export interface KeyedMutex {
  runExclusive: <T>(key: string, task: () => Promise<T>) => Promise<T>;
  /** Number of keys with a task running or queued. */
  activeKeys: () => number;
}

/**
 * Serialises tasks that share a key. Two webhooks for the same company run one
 * after the other, so the second one finds the records the first one created
 * instead of creating duplicates. Different keys still run in parallel.
 */
export const createKeyedMutex = (): KeyedMutex => {
  const tails = new Map<string, Promise<void>>();
  return {
    runExclusive: async (key, task) => {
      const previous = tails.get(key) ?? Promise.resolve();
      let release: () => void = () => undefined;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(async () => current);
      tails.set(key, tail);
      await previous;
      try {
        return await task();
      } finally {
        release();
        if (tails.get(key) === tail) {
          tails.delete(key);
        }
      }
    },
    activeKeys: () => tails.size,
  };
};
