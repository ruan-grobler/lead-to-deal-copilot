export interface Metrics {
  inc: (name: string, by?: number) => void;
  get: (name: string) => number;
  snapshot: () => Record<string, number>;
}

/** In-process counters. The demo report and the health endpoint read them. */
export const createMetrics = (): Metrics => {
  const counters = new Map<string, number>();
  return {
    inc: (name, by = 1) => {
      counters.set(name, (counters.get(name) ?? 0) + by);
    },
    get: (name) => counters.get(name) ?? 0,
    snapshot: () => Object.fromEntries([...counters.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
};
