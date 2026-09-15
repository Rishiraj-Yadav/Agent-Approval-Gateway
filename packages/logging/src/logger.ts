import { redactString, isSensitiveFieldName } from '@raag/security';

/**
 * @raag/logging — structured logging with mandatory redaction
 * (architecture.md §5, security.md §1-10):
 *  - level filtering (debug/info/warn/error),
 *  - output is one JSON line through an injected sink,
 *  - EVERY string (message + metadata) passes through @raag/security redaction
 *    before hitting the sink,
 *  - metadata must be scalar; unknown objects are structurally redacted
 *    (never blindly JSON-dumped; functions/symbols/cycles can't be logged).
 *
 * No production backends are implemented here (console + capture sinks).
 */
export const packageName = '@raag/logging' as const;

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function parseLogLevel(raw: unknown): LogLevel | undefined {
  return typeof raw === 'string' && (LOG_LEVELS as readonly string[]).includes(raw)
    ? (raw as LogLevel)
    : undefined;
}

export type LogMetaValue = string | number | boolean | null;
export type LogMeta = Readonly<Record<string, LogMetaValue>>;

/** One rendered log line. */
export interface LogRecord {
  readonly at: number | string;
  readonly level: LogLevel;
  readonly message: string;
  readonly meta: Readonly<Record<string, unknown>>;
  readonly logger: string;
}

export type LogSink = (line: string) => void;

export interface Logger {
  readonly logger: string;
  readonly level: LogLevel;
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  child(suffix: string): Logger;
}

export interface LoggerOptions {
  readonly name: string;
  readonly level: LogLevel;
  readonly sink?: LogSink;
  /** Epoch-ms supplier (inject a FakeClock.now in tests). */
  readonly now?: () => number;
}

/** Stdout sink. Kept dumb: writing is not logging's concern. */
export function consoleSink(): LogSink {
  return (line) => {
    process.stdout.write(`${line}\n`);
  };
}

/** Test sink: collects lines. */
export function createCaptureSink(): { sink: LogSink; lines: () => readonly string[] } {
  const lines: string[] = [];
  return {
    sink: (line) => {
      lines.push(line);
    },
    lines: () => lines,
  };
}

class StructuredLogger implements Logger {
  constructor(
    readonly logger: string,
    readonly level: LogLevel,
    private readonly sink: LogSink,
    private readonly now: () => number,
  ) {}

  child(suffix: string): Logger {
    return new StructuredLogger(
      `${this.logger}.${redactString(suffix).slice(0, 64)}`,
      this.level,
      this.sink,
      this.now,
    );
  }

  private at(level: LogLevel, message: string, meta?: LogMeta): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;
    const safeMeta: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(meta ?? {})) {
      safeMeta[redactString(key).slice(0, 64)] = isSensitiveFieldName(key)
        ? '[redacted]'
        : typeof value === 'string'
          ? redactString(value)
          : value;
    }
    const record: LogRecord = {
      at: this.now(),
      level,
      message: redactString(message),
      meta: safeMeta,
      logger: this.logger,
    };
    this.sink(JSON.stringify(record));
  }

  debug(message: string, meta?: LogMeta): void {
    this.at('debug', message, meta);
  }
  info(message: string, meta?: LogMeta): void {
    this.at('info', message, meta);
  }
  warn(message: string, meta?: LogMeta): void {
    this.at('warn', message, meta);
  }
  error(message: string, meta?: LogMeta): void {
    this.at('error', message, meta);
  }
}

export function createLogger(options: LoggerOptions): Logger {
  if (options.name.trim().length === 0) {
    throw new Error('logging: logger name must not be blank');
  }
  return new StructuredLogger(
    options.name,
    options.level,
    options.sink ?? consoleSink(),
    options.now ?? (() => Date.now()),
  );
}
