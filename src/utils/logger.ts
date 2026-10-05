import {
  RollingFileSink,
  type FileLogOptions,
  type FileLogPruneCandidate,
  type FileLogPruneResult,
  type FileSinkFailureHandler,
} from './rolling-file-sink.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  meta?: unknown;
}

type SerializedLogEntry = Record<string, unknown>;

class LoggerBackend {
  private fileSink?: RollingFileSink;

  writeFile(entry: SerializedLogEntry): void {
    if (!this.fileSink) return;
    this.fileSink.write(JSON.stringify(entry));
  }

  async configureFileLogging(
    options: FileLogOptions,
    onFailure?: FileSinkFailureHandler,
  ): Promise<void> {
    const next = new RollingFileSink(options, onFailure);
    await next.initialize();

    const previous = this.fileSink;
    this.fileSink = next;
    await previous?.close();
  }

  async previewFileLogCleanup(now?: Date): Promise<FileLogPruneCandidate[]> {
    return this.requireFileSink().previewPrune(now);
  }

  async pruneFileLogs(now?: Date): Promise<FileLogPruneResult> {
    return this.requireFileSink().prune(now);
  }

  async flush(): Promise<void> {
    await this.fileSink?.flush();
  }

  async reopen(): Promise<void> {
    await this.requireFileSink().reopen();
  }

  async close(): Promise<void> {
    const sink = this.fileSink;
    this.fileSink = undefined;
    await sink?.close();
  }

  private requireFileSink(): RollingFileSink {
    if (!this.fileSink) throw new Error('File logging is not configured');
    return this.fileSink;
  }
}

export class Logger {
  private readonly level: LogLevel;
  private readonly format: LogFormat;
  private readonly levelValue: number;
  private readonly context?: Record<string, unknown>;
  private readonly backend: LoggerBackend;

  constructor(
    level: LogLevel = 'info',
    format: LogFormat = 'text',
    context?: Record<string, unknown>,
    backend?: LoggerBackend,
  ) {
    this.level = level;
    this.format = format;
    this.levelValue = LEVELS[level] ?? LEVELS.info;
    this.context = context;
    this.backend = backend ?? new LoggerBackend();
  }

  child(context: Record<string, unknown>): Logger {
    return new Logger(this.level, this.format, { ...this.context, ...context }, this.backend);
  }

  async configureFileLogging(
    options: FileLogOptions,
    onFailure?: FileSinkFailureHandler,
  ): Promise<void> {
    await this.backend.configureFileLogging(options, onFailure);
  }

  async previewFileLogCleanup(now?: Date): Promise<FileLogPruneCandidate[]> {
    return this.backend.previewFileLogCleanup(now);
  }

  async pruneFileLogs(now?: Date): Promise<FileLogPruneResult> {
    return this.backend.pruneFileLogs(now);
  }

  async flush(): Promise<void> {
    await this.backend.flush();
  }

  async reopenFileLogging(): Promise<void> {
    await this.backend.reopen();
  }

  async close(): Promise<void> {
    await this.backend.close();
  }

  private shouldLog(target: LogLevel): boolean {
    return LEVELS[target] >= this.levelValue;
  }

  private write(entry: LogEntry): void {
    const mergedMeta = entry.meta !== undefined
      ? (typeof entry.meta === 'object' ? entry.meta as Record<string, unknown> : { value: entry.meta })
      : undefined;
    const output: SerializedLogEntry = {
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
      ...this.context,
    };
    if (mergedMeta !== undefined) output.meta = mergedMeta;

    // File output is always structured JSONL, independently of the selected
    // console format. Root and child loggers share this backend.
    this.backend.writeFile(output);

    if (this.format === 'json') {
      this.writeConsole(entry.level, JSON.stringify(output));
      return;
    }

    const { timestamp, level, message } = entry;
    let line = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    if (this.context) {
      const ctxStr = Object.entries(this.context).map(([key, value]) => `${key}=${value}`).join(' ');
      line += ` (${ctxStr})`;
    }
    if (mergedMeta !== undefined) {
      const metaStr = typeof mergedMeta === 'object' ? JSON.stringify(mergedMeta) : String(mergedMeta);
      line += ` ${metaStr}`;
    }
    this.writeConsole(entry.level, line);
  }

  private writeConsole(level: LogLevel, line: string): void {
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  debug(msg: string, meta?: unknown): void {
    if (!this.shouldLog('debug')) return;
    this.write({ timestamp: new Date().toISOString(), level: 'debug', message: msg, meta });
  }

  info(msg: string, meta?: unknown): void {
    if (!this.shouldLog('info')) return;
    this.write({ timestamp: new Date().toISOString(), level: 'info', message: msg, meta });
  }

  warn(msg: string, meta?: unknown): void {
    if (!this.shouldLog('warn')) return;
    this.write({ timestamp: new Date().toISOString(), level: 'warn', message: msg, meta });
  }

  error(msg: string, meta?: unknown): void {
    if (!this.shouldLog('error')) return;
    let finalMeta: unknown = meta;
    if (meta instanceof Error) {
      finalMeta = { message: meta.message, stack: meta.stack };
    }
    this.write({ timestamp: new Date().toISOString(), level: 'error', message: msg, meta: finalMeta });
  }
}

function getEnvLevel(): LogLevel {
  const env = process.env.LOG_LEVEL?.toLowerCase();
  if (env === 'debug' || env === 'info' || env === 'warn' || env === 'error') {
    return env;
  }
  return 'info';
}

function getEnvFormat(): LogFormat {
  const env = process.env.LOG_FORMAT?.toLowerCase();
  if (env === 'json') return 'json';
  return 'text';
}

export const logger = new Logger(getEnvLevel(), getEnvFormat());

export async function configureFileLogging(
  options: FileLogOptions,
  onFailure?: FileSinkFailureHandler,
): Promise<void> {
  await logger.configureFileLogging(options, onFailure);
}

export async function previewFileLogCleanup(now?: Date): Promise<FileLogPruneCandidate[]> {
  return logger.previewFileLogCleanup(now);
}

export async function pruneFileLogs(now?: Date): Promise<FileLogPruneResult> {
  return logger.pruneFileLogs(now);
}

export async function flushLogger(): Promise<void> {
  await logger.flush();
}

export async function reopenFileLogger(): Promise<void> {
  await logger.reopenFileLogging();
}

export async function closeLogger(): Promise<void> {
  await logger.close();
}

/**
 * Drain and close the shared file backend without allowing filesystem I/O to
 * hold process shutdown open indefinitely. Returns false on timeout/failure.
 */
export async function shutdownLogger(timeoutMs: number): Promise<boolean> {
  const boundedTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.min(2_147_483_647, Math.max(0, Math.floor(timeoutMs)))
    : 0;
  let timeout: NodeJS.Timeout | undefined;
  const closeOperation = (async () => {
    let succeeded = true;
    try {
      await flushLogger();
    } catch {
      succeeded = false;
    }
    try {
      await closeLogger();
    } catch {
      succeeded = false;
    }
    return succeeded;
  })();
  const deadline = new Promise<false>(resolve => {
    timeout = setTimeout(() => resolve(false), boundedTimeoutMs);
  });

  try {
    return await Promise.race([closeOperation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export type {
  FileLogOptions,
  FileLogPruneCandidate,
  FileLogPruneOutcome,
  FileLogPruneReason,
  FileLogPruneResult,
  FileSinkFailureHandler,
  FileSinkFailureOperation,
} from './rolling-file-sink.js';
