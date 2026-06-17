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
  private context?: Record<string, unknown>;

  constructor(level: LogLevel = 'info', format: LogFormat = 'text', context?: Record<string, unknown>) {
    this.level = level;
    this.format = format;
    this.levelValue = LEVELS[level] ?? LEVELS.info;
    this.context = context;
  }

  child(context: Record<string, unknown>): Logger {
    return new Logger(this.level, this.format, { ...this.context, ...context });
  }

  private shouldLog(target: LogLevel): boolean {
    return LEVELS[target] >= this.levelValue;
  }

  private write(entry: LogEntry): void {
    const mergedMeta = this.context ? { ...this.context, ...(entry.meta !== undefined ? (typeof entry.meta === 'object' ? entry.meta as Record<string, unknown> : { value: entry.meta }) : {}) } : entry.meta;
    if (this.format === 'json') {
      const output: Record<string, unknown> = {
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
        ...this.context,
      };
      if (mergedMeta !== undefined) {
        output.meta = mergedMeta;
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
      const { timestamp, level, message } = entry;
      let line = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
      if (this.context) {
        const ctxStr = Object.entries(this.context).map(([k, v]) => `${k}=${v}`).join(' ');
        line += ` (${ctxStr})`;
      }
      if (mergedMeta !== undefined) {
        const metaStr = typeof mergedMeta === 'object' ? JSON.stringify(mergedMeta) : String(mergedMeta);
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
