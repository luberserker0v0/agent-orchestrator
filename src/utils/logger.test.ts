import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  configureFileLogging as configureSharedFileLogging,
  logger as sharedLogger,
  Logger,
  shutdownLogger,
} from './logger.js';
import { FILE_LOG_ACTIVE_NAME } from './rolling-file-sink.js';

describe('Logger', () => {
  let logs: string[] = [];
  let errors: string[] = [];
  let warns: string[] = [];
  const tempDirectories: string[] = [];

  beforeEach(() => {
    logs = [];
    errors = [];
    warns = [];
    vi.spyOn(console, 'log').mockImplementation((msg: unknown) => logs.push(String(msg)));
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => errors.push(String(msg)));
    vi.spyOn(console, 'warn').mockImplementation((msg: unknown) => warns.push(String(msg)));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
  });

  async function tempDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'ao-logger-'));
    tempDirectories.push(directory);
    return directory;
  }

  it('should filter messages below configured level', () => {
    const logger = new Logger('warn', 'text');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(logs).toHaveLength(0);
    expect(warns).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(warns[0]).toContain('WARN: w');
    expect(errors[0]).toContain('ERROR: e');
  });

  it('should output JSON when format is json', () => {
    const logger = new Logger('info', 'json');
    logger.info('hello', { foo: 'bar' });

    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('hello');
    expect(parsed.meta).toEqual({ foo: 'bar' });
    expect(parsed.timestamp).toBeDefined();
  });

  it('should omit meta key in JSON when meta is absent', () => {
    const logger = new Logger('info', 'json');
    logger.info('plain');

    const parsed = JSON.parse(logs[0]);
    expect(parsed).not.toHaveProperty('meta');
  });

  it('should convert Error meta to object in JSON format', () => {
    const logger = new Logger('error', 'json');
    const err = new Error('boom');
    logger.error('fail', err);

    expect(errors).toHaveLength(1);
    const parsed = JSON.parse(errors[0]);
    expect(parsed.meta.message).toBe('boom');
    expect(parsed.meta.stack).toBeDefined();
  });

  it('should convert Error meta to object in text format', () => {
    const logger = new Logger('error', 'text');
    const err = new Error('boom');
    logger.error('fail', err);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('boom');
  });

  it('should log all levels when level is debug', () => {
    const logger = new Logger('debug', 'text');
    logger.debug('d');
    logger.info('i');

    expect(logs).toHaveLength(2);
  });

  it('should include non-object meta as string in text format', () => {
    const logger = new Logger('info', 'text');
    logger.info('msg', 42);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('42');
  });

  describe('child()', () => {
    it('creates a logger with bound context', () => {
      const parent = new Logger('info', 'json');
      const child = parent.child({ requestId: 'req-123', conversationId: 'conv-456' });
      child.info('hello');

      const parsed = JSON.parse(logs[0]);
      expect(parsed.requestId).toBe('req-123');
      expect(parsed.conversationId).toBe('conv-456');
      expect(parsed.message).toBe('hello');
    });

    it('includes context in text format output', () => {
      const parent = new Logger('info', 'text');
      const child = parent.child({ requestId: 'req-789' });
      child.info('test');

      expect(logs[0]).toContain('req-789');
    });

    it('merges parent context with child context', () => {
      const parent = new Logger('info', 'json').child({ app: 'ao' });
      const child = parent.child({ requestId: 'req-xyz' });
      child.info('merged');

      const parsed = JSON.parse(logs[0]);
      expect(parsed.app).toBe('ao');
      expect(parsed.requestId).toBe('req-xyz');
    });

    it('child context overrides parent context on key conflict', () => {
      const parent = new Logger('info', 'json').child({ id: 'parent' });
      const child = parent.child({ id: 'child' });
      child.info('override');

      const parsed = JSON.parse(logs[0]);
      expect(parsed.id).toBe('child');
    });

    it('inherits level and format from parent', () => {
      const parent = new Logger('warn', 'text');
      const child = parent.child({ ctx: 'val' });
      child.info('should not appear');
      child.warn('should appear');

      expect(logs).toHaveLength(0);
      expect(warns[0]).toContain('should appear');
    });
  });

  describe('file logging', () => {
    it('mirrors filtered root and child records as ordered JSONL while preserving console output', async () => {
      const directory = await tempDirectory();
      const parent = new Logger('info', 'text');
      const child = parent.child({ requestId: 'req-123' });
      await parent.configureFileLogging({
        directory,
        maxFileSizeBytes: 1024 * 1024,
        maxRotatedFiles: 3,
        retentionMs: 60_000,
      });

      parent.debug('filtered');
      parent.info('parent');
      child.warn('child', { attempt: 2 });
      parent.error('last', new Error('boom'));
      await child.flush();

      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('INFO: parent');
      expect(warns[0]).toContain('WARN: child');
      expect(errors[0]).toContain('ERROR: last');

      const lines = (await readFile(join(directory, FILE_LOG_ACTIVE_NAME), 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      expect(lines.map(line => line.message)).toEqual(['parent', 'child', 'last']);
      expect(lines[1]).toMatchObject({
        level: 'warn',
        requestId: 'req-123',
        meta: { attempt: 2 },
      });
      expect(lines[2].meta).toMatchObject({ message: 'boom' });
      await parent.close();
    });

    it('emits JSONL even when console logging uses text format', async () => {
      const directory = await tempDirectory();
      const instance = new Logger('info', 'text', { component: 'test' });
      await instance.configureFileLogging({
        directory,
        maxFileSizeBytes: 1024,
        maxRotatedFiles: 1,
        retentionMs: 60_000,
      });

      instance.info('structured', 42);
      await instance.flush();

      expect(logs[0]).toContain('INFO: structured');
      const record = JSON.parse((await readFile(join(directory, FILE_LOG_ACTIVE_NAME), 'utf8')).trim());
      expect(record).toMatchObject({
        level: 'info',
        message: 'structured',
        component: 'test',
        meta: { value: 42 },
      });
      await instance.close();
    });

    it('supports non-mutating preview, pruning, reopen, and idempotent close', async () => {
      const directory = await tempDirectory();
      const instance = new Logger();
      await instance.configureFileLogging({
        directory,
        maxFileSizeBytes: 1024,
        maxRotatedFiles: 1,
        retentionMs: 60_000,
      });

      expect(await instance.previewFileLogCleanup()).toEqual([]);
      expect(await instance.pruneFileLogs()).toMatchObject({ eligible: 0, deleted: 0, failed: 0 });
      await instance.reopenFileLogging();
      instance.info('after reopen');
      await instance.flush();
      expect(await readFile(join(directory, FILE_LOG_ACTIVE_NAME), 'utf8')).toContain('after reopen');
      await instance.close();
      await instance.close();
    });

    it('leaves the current sink active when replacement initialization fails', async () => {
      const directory = await tempDirectory();
      const unsafe = join(await tempDirectory(), 'active-is-directory');
      await writeFile(unsafe, 'not a directory');
      const instance = new Logger();
      await instance.configureFileLogging({
        directory,
        maxFileSizeBytes: 1024,
        maxRotatedFiles: 1,
        retentionMs: 60_000,
      });

      // An unsafe destination is rejected before it can replace the working sink.
      await expect(instance.configureFileLogging({
        directory: unsafe,
        maxFileSizeBytes: 1024,
        maxRotatedFiles: 1,
        retentionMs: 60_000,
      })).rejects.toThrow();
      instance.info('still active');
      await instance.flush();
      expect(await readFile(join(directory, FILE_LOG_ACTIVE_NAME), 'utf8')).toContain('still active');
      await instance.close();
    });

    it('rejects cleanup operations before file logging is configured', async () => {
      const instance = new Logger();
      await expect(instance.previewFileLogCleanup()).rejects.toThrow(/not configured/i);
      await expect(instance.pruneFileLogs()).rejects.toThrow(/not configured/i);
      await expect(instance.reopenFileLogging()).rejects.toThrow(/not configured/i);
      await instance.flush();
      await instance.close();
    });

    it('flushes and closes the shared backend within a shutdown bound', async () => {
      const directory = await tempDirectory();
      await configureSharedFileLogging({
        directory,
        maxFileSizeBytes: 1024,
        maxRotatedFiles: 1,
        retentionMs: 60_000,
      });
      sharedLogger.info('final shared record');

      await expect(shutdownLogger(1_000)).resolves.toBe(true);
      expect(await readFile(join(directory, FILE_LOG_ACTIVE_NAME), 'utf8')).toContain('final shared record');
      await expect(shutdownLogger(1_000)).resolves.toBe(true);
    });
  });
});
