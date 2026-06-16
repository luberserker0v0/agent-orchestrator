import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('cross-spawn', () => ({ spawn: vi.fn() }));
vi.mock('tree-kill', () => ({
  default: vi.fn((_pid: number, _signal: string | number | undefined, cb: (err: Error | null) => void) => cb(null)),
}));

import { spawn } from 'cross-spawn';
import { PortPool } from '../../orchestrator/port-pool.js';
import { DirectRuntime } from './direct.js';

function createMockProc(opts: { exitCode?: number | null; pid?: number | undefined } = {}) {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  return {
    pid: 'pid' in opts ? opts.pid : 12345,
    killed: false,
    exitCode: 'exitCode' in opts ? opts.exitCode : 0,
    stdout: {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        const key = `stdout:${event}`;
        if (!listeners[key]) listeners[key] = [];
        listeners[key].push(cb);
      },
      emit: (event: string, ...args: unknown[]) => {
        const key = `stdout:${event}`;
        const cbs = listeners[key] ?? [];
        cbs.forEach((cb) => cb(...args));
      },
    },
    stderr: {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        const key = `stderr:${event}`;
        if (!listeners[key]) listeners[key] = [];
        listeners[key].push(cb);
      },
      emit: (event: string, ...args: unknown[]) => {
        const key = `stderr:${event}`;
        const cbs = listeners[key] ?? [];
        cbs.forEach((cb) => cb(...args));
      },
    },
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    },
    once: (event: string, cb: (...args: unknown[]) => void) => {
      const wrapper = (...args: unknown[]) => {
        cb(...args);
        const idx = listeners[event]?.indexOf(wrapper);
        if (idx !== undefined && idx > -1) listeners[event].splice(idx, 1);
      };
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(wrapper);
    },
    emit: (event: string, ...args: unknown[]) => {
      const cbs = listeners[event] ?? [];
      cbs.forEach((cb) => cb(...args));
    },
  };
}

function makeHealthyFetch() {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({ healthy: true, version: '1.0.0' }),
  };
}

function createPortPool(start = 40000, end = 40050): PortPool {
  return new PortPool(start, end, false);
}

describe('DirectRuntime', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('defaults binary to "opencode"', () => {
      const rt = new DirectRuntime(createPortPool());
      expect((rt as any).binary).toBe('opencode');
    });

    it('accepts custom binary', () => {
      const rt = new DirectRuntime(createPortPool(), 'my-opencode');
      expect((rt as any).binary).toBe('my-opencode');
    });

    it('exposes type and capabilities', () => {
      const rt = new DirectRuntime(createPortPool());
      expect(rt.type).toBe('opencode');
      expect(rt.capabilities).toEqual({
        sessions: true, streaming: true, files: true,
        tools: true, config: true, agents: true, skills: true,
      });
    });
  });

  describe('spawn', () => {
    it('calls spawn with correct binary and args', async () => {
      const rt = new DirectRuntime(createPortPool(), 'my-opencode');
      const mockProc = createMockProc();
      (spawn as any).mockReturnValue(mockProc);
      mockFetch.mockResolvedValue(makeHealthyFetch());

      const result = await rt.spawn(
        'test-id',
        '/tmp/ws',
        { username: 'u', password: 'p' },
        { retries: 2, intervalMs: 1, clientTimeoutMs: 5000 },
      );

      expect(spawn).toHaveBeenCalledWith(
        'my-opencode',
        ['serve', '--port', expect.any(String), '--hostname', '127.0.0.1'],
        expect.objectContaining({
          cwd: '/tmp/ws',
          env: expect.objectContaining({
            OPENCODE_SERVER_USERNAME: 'u',
            OPENCODE_SERVER_PASSWORD: 'p',
          }),
        }),
      );
      expect(result.port).toBeGreaterThanOrEqual(40000);
      expect(result.handle).toBeDefined();
      expect(result.client).toBeDefined();
    });

    it('throws when health check fails after all retries', async () => {
      const rt = new DirectRuntime(createPortPool());
      const mockProc = createMockProc();
      (spawn as any).mockReturnValue(mockProc);
      mockFetch.mockRejectedValue(new Error('connection refused'));

      await expect(rt.spawn(
        'test-id', '/tmp/ws',
        { username: 'u', password: 'p' },
        { retries: 2, intervalMs: 1, clientTimeoutMs: 5000 },
      )).rejects.toThrow('OpenCode instance failed health check after 2 retries');
    });

    it('succeeds when health check passes after initial failures', async () => {
      const rt = new DirectRuntime(createPortPool());
      const mockProc = createMockProc();
      (spawn as any).mockReturnValue(mockProc);
      mockFetch
        .mockRejectedValueOnce(new Error('not ready'))
        .mockResolvedValue(makeHealthyFetch());

      const result = await rt.spawn(
        'test-id', '/tmp/ws',
        { username: 'u', password: 'p' },
        { retries: 3, intervalMs: 1, clientTimeoutMs: 5000 },
      );

      expect(result.handle).toBeDefined();
      expect(result.client).toBeDefined();
    });

    it('throws when no ports available', async () => {
      const smallPool = new PortPool(40000, 40000, false);
      await smallPool.allocate();
      // Only one port and it's taken
      const rt = new DirectRuntime(smallPool);
      await expect(rt.spawn(
        'test-id', '/tmp/ws',
        { username: 'u', password: 'p' },
        { retries: 1, intervalMs: 1, clientTimeoutMs: 5000 },
      )).rejects.toThrow('No available ports in pool');
    });
  });

  describe('kill', () => {
    it('calls treeKill via handle', async () => {
      const rt = new DirectRuntime(createPortPool());
      const mockProc = createMockProc({ exitCode: null, pid: 9999 });
      (spawn as any).mockReturnValue(mockProc);
      mockFetch.mockResolvedValue(makeHealthyFetch());

      const result = await rt.spawn(
        'test-kill', '/tmp/ws',
        { username: 'u', password: 'p' },
        { retries: 1, intervalMs: 1, clientTimeoutMs: 5000 },
      );

      await rt.kill(result.handle);
      const { default: treeKill } = await import('tree-kill');
      expect(treeKill).toHaveBeenCalledWith(9999, 'SIGTERM', expect.any(Function));
    });

    it('noop when handle is undefined', async () => {
      const rt = new DirectRuntime(createPortPool());
      await expect(rt.kill(undefined)).resolves.toBeUndefined();
    });
  });
});
