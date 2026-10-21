export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

export interface DailySchedule {
  hour: number;
  minute: number;
  timeZone: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

/** Wall clock parts of an instant in a time zone, for example 08:00 in Africa/Johannesburg. */
export const zonedParts = (date: Date, timeZone: string): ZonedParts => {
  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday ?? '',
  };
};

const pad = (value: number): string => String(value).padStart(2, '0');

/** YYYY-MM-DD of the instant in the given time zone. */
export const localDateKey = (date: Date, timeZone: string): string => {
  const p = zonedParts(date, timeZone);
  return `${String(p.year)}-${pad(p.month)}-${pad(p.day)}`;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Wed 21 Oct 2026" in the given time zone. */
export const localDateLabel = (date: Date, timeZone: string): string => {
  const p = zonedParts(date, timeZone);
  return `${p.weekday} ${String(p.day)} ${MONTHS[p.month - 1] ?? ''} ${String(p.year)}`;
};

/** "08:05" in the given time zone. */
export const localTimeLabel = (date: Date, timeZone: string): string => {
  const p = zonedParts(date, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
};

/** Converts a wall clock time in a zone to the UTC instant. Two passes make it correct across DST changes. */
export const zonedTimeToUtc = (year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date => {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let pass = 0; pass < 2; pass += 1) {
    const p = zonedParts(new Date(guess), timeZone);
    const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - guess;
    guess = target - offset;
  }
  return new Date(guess);
};

/** The next time the daily job should run, strictly after `now`. */
export const nextDailyRun = (now: Date, schedule: DailySchedule): Date => {
  const p = zonedParts(now, schedule.timeZone);
  const today = zonedTimeToUtc(p.year, p.month, p.day, schedule.hour, schedule.minute, schedule.timeZone);
  if (today.getTime() > now.getTime()) {
    return today;
  }
  const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedTimeToUtc(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), schedule.hour, schedule.minute, schedule.timeZone);
};

/** True once the local time has reached the scheduled time today. The caller makes it once per day. */
export const isDailyRunDue = (now: Date, schedule: DailySchedule): boolean => {
  const p = zonedParts(now, schedule.timeZone);
  return p.hour * 60 + p.minute >= schedule.hour * 60 + schedule.minute;
};

/** 125 to "2 h 5 min". */
export const formatDuration = (minutes: number): string => {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) {
    return `${String(rest)} min`;
  }
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
};
