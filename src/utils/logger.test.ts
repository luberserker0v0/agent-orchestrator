import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from './logger.js';

describe('Logger', () => {
  let logs: string[] = [];
  let errors: string[] = [];
  let warns: string[] = [];

  beforeEach(() => {
    logs = [];
    errors = [];
    warns = [];
    vi.spyOn(console, 'log').mockImplementation((msg: unknown) => logs.push(String(msg)));
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => errors.push(String(msg)));
    vi.spyOn(console, 'warn').mockImplementation((msg: unknown) => warns.push(String(msg)));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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
});
