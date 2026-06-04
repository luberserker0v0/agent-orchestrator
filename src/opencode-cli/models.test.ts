import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listModels } from './models.js';

// Mock cross-spawn before importing the module under test
vi.mock('cross-spawn', () => ({
  spawn: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { spawn } from 'cross-spawn';
import { logger } from '../utils/logger.js';

function createMockProc() {
  const stdoutListeners: ((data: Buffer) => void)[] = [];
  const stderrListeners: ((data: Buffer) => void)[] = [];
  const closeListeners: ((code: number | null) => void)[] = [];
  const errorListeners: ((err: Error) => void)[] = [];

  const mockProc = {
    stdout: {
      on: (event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stdoutListeners.push(cb);
      },
      emit: (event: string, data: Buffer) => {
        stdoutListeners.forEach((cb) => cb(data));
      },
    },
    stderr: {
      on: (event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') stderrListeners.push(cb);
      },
      emit: (event: string, data: Buffer) => {
        stderrListeners.forEach((cb) => cb(data));
      },
    },
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close') closeListeners.push(cb as (code: number | null) => void);
      if (event === 'error') errorListeners.push(cb as (err: Error) => void);
    },
    emitClose: (code: number | null) => {
      closeListeners.forEach((cb) => cb(code));
    },
    emitError: (err: Error) => {
      errorListeners.forEach((cb) => cb(err));
    },
    kill: vi.fn(),
  };

  return mockProc;
}

describe('listModels', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('parses model list from stdout', async () => {
    const mockProc = createMockProc();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);

    const promise = listModels('opencode');

    mockProc.stdout.emit('data', Buffer.from('anthropic/claude\ngoogle/gemini\n'));
    mockProc.emitClose(0);

    const result = await promise;

    expect(result).toEqual([
      { id: 'anthropic/claude', provider: 'anthropic', model: 'claude' },
      { id: 'google/gemini', provider: 'google', model: 'gemini' },
    ]);
    expect(spawn).toHaveBeenCalledWith('opencode', ['models'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('returns empty array on empty stdout', async () => {
    const mockProc = createMockProc();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);

    const promise = listModels('opencode');

    mockProc.emitClose(0);

    const result = await promise;
    expect(result).toEqual([]);
  });

  it('returns empty array on non-zero exit code', async () => {
    const mockProc = createMockProc();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);

    const promise = listModels('opencode');

    mockProc.stderr.emit('data', Buffer.from('some error'));
    mockProc.emitClose(1);

    const result = await promise;
    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('exited with code 1'));
  });

  it('returns empty array and kills process on timeout', async () => {
    const mockProc = createMockProc();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);

    const promise = listModels('opencode');

    vi.advanceTimersByTime(10001);

    const result = await promise;
    expect(result).toEqual([]);
    expect(mockProc.kill).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('timed out'));
  });

  it('returns empty array on spawn error', async () => {
    const mockProc = createMockProc();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);

    const promise = listModels('opencode');

    mockProc.emitError(new Error('ENOENT'));

    const result = await promise;
    expect(result).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to spawn'), 'ENOENT');
  });

  it('ignores malformed lines without slash', async () => {
    const mockProc = createMockProc();
    (spawn as ReturnType<typeof vi.fn>).mockReturnValue(mockProc);

    const promise = listModels('opencode');

    mockProc.stdout.emit('data', Buffer.from('anthropic/claude\nbad-line\ngoogle/gemini-pro\n'));
    mockProc.emitClose(0);

    const result = await promise;
    expect(result).toEqual([
      { id: 'anthropic/claude', provider: 'anthropic', model: 'claude' },
      { id: 'google/gemini-pro', provider: 'google', model: 'gemini-pro' },
    ]);
  });
});
