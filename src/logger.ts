export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug: (msg: string, fields?: LogFields) => void;
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
  error: (msg: string, fields?: LogFields) => void;
  child: (bindings: LogFields) => Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  write?: (line: string) => void;
  bindings?: LogFields;
  now?: () => Date;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

const serializeValue = (value: unknown): unknown => {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  return value;
};

const defaultWrite = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/**
 * Structured JSON logger: one JSON object per line, so logs can be shipped
 * to any collector without parsing. Never pass raw lead text or full contact
 * details as fields; use the mask helpers below.
 */
export const createLogger = (options: LoggerOptions): Logger => {
  const write = options.write ?? defaultWrite;
  const now = options.now ?? ((): Date => new Date());
  const bindings = options.bindings ?? {};

  const emit = (level: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields): void => {
    if (LEVEL_RANK[level] < LEVEL_RANK[options.level]) {
      return;
    }
    const entry: LogFields = { ts: now().toISOString(), level, msg, ...bindings };
    for (const [key, value] of Object.entries(fields ?? {})) {
      entry[key] = serializeValue(value);
    }
    write(JSON.stringify(entry));
  };

  return {
    debug: (msg, fields) => {
      emit('debug', msg, fields);
    },
    info: (msg, fields) => {
      emit('info', msg, fields);
    },
    warn: (msg, fields) => {
      emit('warn', msg, fields);
    },
    error: (msg, fields) => {
      emit('error', msg, fields);
    },
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
};

export const silentLogger: Logger = createLogger({ level: 'silent' });

/** t***@karoo-freight.example.com: enough to debug, not enough to identify. */
export const maskEmail = (email: string | null | undefined): string | null => {
  if (!email) {
    return null;
  }
  const at = email.indexOf('@');
  if (at < 1) {
    return '***';
  }
  return `${email.slice(0, 1)}***${email.slice(at)}`;
};

export const maskPhone = (phone: string | null | undefined): string | null => {
  if (!phone) {
    return null;
  }
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) {
    return '***';
  }
  return `***${digits.slice(-4)}`;
};
