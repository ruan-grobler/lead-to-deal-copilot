export interface Clock {
  now: () => Date;
}

export interface FakeClock extends Clock {
  advance: (ms: number) => void;
  set: (date: Date) => void;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const createFakeClock = (start: Date): FakeClock => {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
    set: (date) => {
      current = date.getTime();
    },
  };
};

export const sleep = async (ms: number): Promise<void> => {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
