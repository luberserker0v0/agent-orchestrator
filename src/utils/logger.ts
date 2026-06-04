type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogFormat = 'text' | 'json';

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

export class Logger {
  private level: LogLevel;
  private format: LogFormat;
  private levelValue: number;

  constructor(level: LogLevel = 'info', format: LogFormat = 'text') {
    this.level = level;
    this.format = format;
    this.levelValue = LEVELS[level] ?? LEVELS.info;
  }

  private shouldLog(target: LogLevel): boolean {
    return LEVELS[target] >= this.levelValue;
  }

  private write(entry: LogEntry): void {
    if (this.format === 'json') {
      const output: Record<string, unknown> = {
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
      };
      if (entry.meta !== undefined) {
        output.meta = entry.meta;
      }
      const line = JSON.stringify(output);
      if (entry.level === 'error') {
        console.error(line);
      } else if (entry.level === 'warn') {
        console.warn(line);
      } else {
        console.log(line);
      }
    } else {
      const { timestamp, level, message, meta } = entry;
      let line = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
      if (meta !== undefined) {
        const metaStr = typeof meta === 'object' ? JSON.stringify(meta) : String(meta);
        line += ` ${metaStr}`;
      }
      if (entry.level === 'error') {
        console.error(line);
      } else if (entry.level === 'warn') {
        console.warn(line);
      } else {
        console.log(line);
      }
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
