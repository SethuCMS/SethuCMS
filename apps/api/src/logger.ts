/**
 * Logging.
 *
 * One line per event on stderr (the start-up banner is the only thing on
 * stdout),
 * as JSON by default so log tools can parse it, or as readable text for a
 * person
 * at a terminal. Fields pass through `redact` first, so a password, token or
 * connection-string credential that ends up in a log field is hidden anyway.
 * Never log request bodies or query strings on purpose.
 */
import { redact } from '@sethucms/core';

/** Severity of a log line, lowest to highest. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** `json` for machines (default); `pretty` for a person at a terminal. */
export type LogFormat = 'json' | 'pretty';

/** All levels, lowest first; used to validate SETHUCMS_LOG_LEVEL. */
export const LOG_LEVELS: readonly LogLevel[] = [
  'debug',
  'info',
  'warn',
  'error',
];
// Numeric order so a threshold check is a single comparison.
const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Structured logger. Every method takes a field bag (not a format string)
 * so output stays machine-parseable and can be redacted by key.
 */
export interface Logger {
  debug(fields: Record<string, unknown>): void;
  info(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
  /**
   * A logger that adds the same fields to every line (for example a connection
   * id).
   */
  child(fields: Record<string, unknown>): Logger;
}

/** Settings for `createLogger`; all optional. */
export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  /** Where lines go. Defaults to stderr. */
  write?: (line: string) => void;
  /** Fields added to every line. */
  base?: Record<string, unknown>;
}

/**
 * Build a logger that writes one line per event.
 *
 * @param options Level threshold, output format, sink and base fields.
 * @returns A `Logger`; `child()` loggers share the same settings.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = RANK[options.level ?? 'info'];
  const format = options.format ?? 'json';
  const write =
    options.write ?? ((line: string) => void process.stderr.write(line));
  const base = options.base ?? {};

  const emit = (level: LogLevel, fields: Record<string, unknown>): void => {
    if (RANK[level] < threshold) {
      return;
    }
    // Redact after merging so secrets in base fields are masked too.
    const merged = redact({ ...base, ...fields }) as Record<string, unknown>;
    const at = new Date().toISOString();
    write(
      format === 'json'
        ? JSON.stringify({ level, at, ...merged }) + '\n'
        : pretty(level, at, merged) + '\n',
    );
  };

  return {
    debug: (fields) => emit('debug', fields),
    info: (fields) => emit('info', fields),
    warn: (fields) => emit('warn', fields),
    error: (fields) => emit('error', fields),
    child: (fields) =>
      createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

// Human-readable line: time, level, event name, then key=value pairs.
function pretty(
  level: LogLevel,
  at: string,
  fields: Record<string, unknown>,
): string {
  const { event, message, stack, ...rest } = fields;
  // Slice keeps only HH:MM:SS.mmm from the ISO timestamp.
  const head = `${at.slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${String(event ?? message ?? '')}`;
  const tail = Object.entries(rest)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(
      ([key, value]) =>
        `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`,
    )
    .join(' ');
  return [head, tail, typeof stack === 'string' ? `\n${stack}` : '']
    .filter(Boolean)
    .join(' ')
    .trimEnd();
}

/**
 * Parse the SETHUCMS_LOG_LEVEL setting.
 *
 * @param value Raw env value; empty or missing means `info`.
 * @returns The matching level, case-insensitively.
 * @throws Error if the value is not a known level (fail fast at start-up).
 */
export function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined || value === '') {
    return 'info';
  }
  const level = value.toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(level)) {
    return level as LogLevel;
  }
  throw new Error(
    `SETHUCMS_LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`,
  );
}

/** Default logger: JSON, info and above. */
export const consoleLogger: Logger = createLogger();

/** Logger that discards everything; handy default for tests and libraries. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
