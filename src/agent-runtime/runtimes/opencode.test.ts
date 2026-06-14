import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('cross-spawn', () => ({ spawn: vi.fn() }));
vi.mock('tree-kill', () => ({
  default: vi.fn((_pid: number, _signal: string | number | undefined, cb: (err: Error | null) => void) => cb(null)),
}));

import { spawn } from 'cross-spawn';
import { OpenCodeRuntime } from './opencode.js';

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

describe('OpenCodeRuntime', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ─── Constructor ───────────────────────────────────────────

  describe('constructor', () => {
    it('parses binary from runtimeConfig', () => {
      const rt = new OpenCodeRuntime('direct', { binary: 'my-opencode' });
      expect((rt as any).opencodeBinary).toBe('my-opencode');
    });

    it('defaults binary to "opencode"', () => {
      const rt = new OpenCodeRuntime('direct', {});
      expect((rt as any).opencodeBinary).toBe('opencode');
    });

    it('parses docker config when runtime is docker', () => {
      const rt = new OpenCodeRuntime('docker', {
        binary: 'opencode',
        docker: { image: 'my-image', containerPort: 8080 },
      });
      expect((rt as any).dockerConfig).toEqual({ image: 'my-image', containerPort: 8080 });
    });

    it('leaves dockerConfig undefined when runtime is direct', () => {
      const rt = new OpenCodeRuntime('direct', {
        binary: 'opencode',
        docker: { image: 'x', containerPort: 1 },
      });
      expect((rt as any).dockerConfig).toBeUndefined();
    });

    it('exposes type and capabilities', () => {
      const rt = new OpenCodeRuntime('direct', { binary: 'opencode' });
      expect(rt.type).toBe('opencode');
      expect(rt.capabilities).toEqual({
        sessions: true, streaming: true, files: true,
        tools: true, config: true, agents: true, skills: true,
      });
    });
  });

  // ─── spawn (direct) ────────────────────────────────────────

  describe('spawn (direct)', () => {
    it('calls spawn with correct binary and args', async () => {
      const rt = new OpenCodeRuntime('direct', { binary: 'my-opencode' });
      const mockProc = createMockProc();
      (spawn as any).mockReturnValue(mockProc);
      mockFetch.mockResolvedValue(makeHealthyFetch());

      const result = await rt.spawn(
        'test-id', 3000, '/tmp/ws',
        { username: 'u', password: 'p' },
        { retries: 2, intervalMs: 1, clientTimeoutMs: 5000 },
      );

      expect(spawn).toHaveBeenCalledWith(
        'my-opencode',
        ['serve', '--port', '3000', '--hostname', '127.0.0.1'],
        expect.objectContaining({
          cwd: '/tmp/ws',
          env: expect.objectContaining({
            OPENCODE_SERVER_USERNAME: 'u',
            OPENCODE_SERVER_PASSWORD: 'p',
          }),
        }),
      );
      expect(result.process).toBe(mockProc);
      expect(result.client).toBeDefined();
    });

    it('throws when health check fails after all retries', async () => {
      const rt = new OpenCodeRuntime('direct', { binary: 'opencode' });
      const mockProc = createMockProc();
      (spawn as any).mockReturnValue(mockProc);
      mockFetch.mockRejectedValue(new Error('connection refused'));

      await expect(rt.spawn(
        'test-id', 3001, '/tmp/ws',
        { username: 'u', password: 'p' },
        { retries: 2, intervalMs: 1, clientTimeoutMs: 5000 },
      )).rejects.toThrow('OpenCode instance failed health check after 2 retries');
    });

    it('succeeds when health check passes after initial failures', async () => {
      const rt = new OpenCodeRuntime('direct', { binary: 'opencode' });
      const mockProc = createMockProc();
      (spawn as any).mockReturnValue(mockProc);
      mockFetch
        .mockRejectedValueOnce(new Error('not ready'))
        .mockResolvedValue(makeHealthyFetch());

      const result = await rt.spawn(
        'test-id', 3002, '/tmp/ws',
        { username: 'u', password: 'p' },
        { retries: 3, intervalMs: 1, clientTimeoutMs: 5000 },
      );

      expect(result.process).toBe(mockProc);
      expect(result.client).toBeDefined();
    });
  });

  // ─── spawn (docker) ────────────────────────────────────────

  describe('spawn (docker)', () => {
    it('calls docker run with correct args', async () => {
      const rt = new OpenCodeRuntime('docker', {
        binary: 'opencode',
        docker: { image: 'test-image', containerPort: 3100 },
      });
      const mockProc = createMockProc({ exitCode: 0 });
      (spawn as any).mockReturnValue(mockProc);
      mockFetch.mockResolvedValue(makeHealthyFetch());

      const result = await rt.spawn(
        'conv-d', 4000, '/tmp/docker-ws',
        { username: 'u', password: 'p' },
        { retries: 2, intervalMs: 1, clientTimeoutMs: 5000 },
      );

      expect(spawn).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['run', '-d', '--name', 'agentorchestrator-conv-d']),
        expect.anything(),
      );
      expect(spawn).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['-p', '127.0.0.1:4000:3100']),
        expect.anything(),
      );
      expect(result.process).toBeUndefined();
      expect(result.client).toBeDefined();
      expect(result.dispose).toBeDefined();
    });

    it('returns dispose function that removes container', async () => {
      const rt = new OpenCodeRuntime('docker', {
        binary: 'opencode',
        docker: { image: 'img', containerPort: 3100 },
      });
      const runProc = createMockProc({ exitCode: 0 });
      (spawn as any).mockReturnValue(runProc);
      mockFetch.mockResolvedValue(makeHealthyFetch());

      const result = await rt.spawn(
        'conv-rm', 4001, '/tmp/ws',
        { username: 'u', password: 'p' },
        { retries: 2, intervalMs: 1, clientTimeoutMs: 5000 },
      );

      // Reset spawn mock for dispose call
      const rmProc = createMockProc();
      (spawn as any).mockReset();
      (spawn as any).mockReturnValue(rmProc);

      await result.dispose!();

      expect(spawn).toHaveBeenCalledWith(
        'docker',
        ['rm', '-f', 'agentorchestrator-conv-rm'],
        expect.anything(),
      );
    });
  });

  // ─── kill ───────────────────────────────────────────────────

  describe('kill', () => {
    it('calls treeKill with correct PID', async () => {
      const rt = new OpenCodeRuntime('direct', { binary: 'opencode' });
      const mockProc = createMockProc({ exitCode: null, pid: 9999 });
      await rt.kill(mockProc as any);
      const { default: treeKill } = await import('tree-kill');
      expect(treeKill).toHaveBeenCalledWith(9999, undefined, expect.any(Function));
    });

    it('noop when process is undefined', async () => {
      const rt = new OpenCodeRuntime('direct', { binary: 'opencode' });
      await expect(rt.kill(undefined as any)).resolves.toBeUndefined();
    });

    it('noop when process already killed', async () => {
      const rt = new OpenCodeRuntime('direct', { binary: 'opencode' });
      const mockProc = createMockProc();
      mockProc.killed = true;
      await rt.kill(mockProc as any);
      const { default: treeKill } = await import('tree-kill');
      expect(treeKill).not.toHaveBeenCalled();
    });

    it('noop when process already exited', async () => {
      const rt = new OpenCodeRuntime('direct', { binary: 'opencode' });
      const mockProc = createMockProc({ exitCode: 0 });
      await rt.kill(mockProc as any);
      const { default: treeKill } = await import('tree-kill');
      expect(treeKill).not.toHaveBeenCalled();
    });
  });

  // ─── cleanupOrphans ─────────────────────────────────────────

  describe('cleanupOrphans', () => {
    it('skips cleanup when runtime is not docker', async () => {
      const rt = new OpenCodeRuntime('direct', { binary: 'opencode' });
      await rt.cleanupOrphans();
      expect(spawn).not.toHaveBeenCalled();
    });

    it('resolves immediately when no orphan containers found', async () => {
      const rt = new OpenCodeRuntime('docker', {
        binary: 'opencode',
        docker: { image: 'img', containerPort: 8080 },
      });
      const psProc = createMockProc({ exitCode: null });
      (spawn as any).mockReturnValue(psProc);

      const promise = rt.cleanupOrphans();
      psProc.stdout.emit('data', Buffer.from(''));
      psProc.emit('exit');

      await promise;
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('lists and removes orphan containers', async () => {
      const rt = new OpenCodeRuntime('docker', {
        binary: 'opencode',
        docker: { image: 'img', containerPort: 8080 },
      });

      const psProc = createMockProc({ exitCode: null });
      const rmProc1 = createMockProc({ exitCode: null });
      const rmProc2 = createMockProc({ exitCode: null });

      (spawn as any)
        .mockReturnValueOnce(psProc)
        .mockReturnValueOnce(rmProc1)
        .mockReturnValueOnce(rmProc2);

      const promise = rt.cleanupOrphans();

      psProc.stdout.emit('data', Buffer.from('agentorchestrator-orphan1\nagentorchestrator-orphan2'));
      psProc.emit('exit');

      rmProc1.emit('exit');
      rmProc2.emit('exit');

      await promise;

      expect(spawn).toHaveBeenCalledWith(
        'docker',
        ['ps', '-a', '--filter', 'name=agentorchestrator-', '--format', '{{.Names}}'],
        expect.anything(),
      );
      expect(spawn).toHaveBeenCalledWith('docker', ['rm', '-f', 'agentorchestrator-orphan1'], expect.anything());
      expect(spawn).toHaveBeenCalledWith('docker', ['rm', '-f', 'agentorchestrator-orphan2'], expect.anything());
    });
  });

  // ─── restart ──────────────────────────────────────────────

  describe('restart', () => {
    it('throws when runtime is not docker', async () => {
      const rt = new OpenCodeRuntime('direct', { binary: 'opencode' });
      const client = { health: vi.fn() } as any;
      await expect(rt.restart('conv-id', client)).rejects.toThrow(
        'restartInstance is only supported for Docker runtime',
      );
    });

    it('restarts container and waits for health check', async () => {
      const rt = new OpenCodeRuntime('docker', {
        binary: 'opencode',
        docker: { image: 'img', containerPort: 8080 },
      });
      const restartProc = createMockProc({ exitCode: 0 });
      (spawn as any).mockReturnValue(restartProc);

      const client = { health: vi.fn().mockResolvedValue({ healthy: true, version: '1.0.0' }) };

      await rt.restart('conv-restart', client as any);

      expect(spawn).toHaveBeenCalledWith(
        'docker',
        ['restart', 'agentorchestrator-conv-restart'],
        expect.anything(),
      );
      expect(client.health).toHaveBeenCalled();
    });

    it('throws when docker restart command fails', async () => {
      const rt = new OpenCodeRuntime('docker', {
        binary: 'opencode',
        docker: { image: 'img', containerPort: 8080 },
      });
      const restartProc = createMockProc({ exitCode: 1 });
      (spawn as any).mockReturnValue(restartProc);

      const client = { health: vi.fn() };
      await expect(rt.restart('conv-fail', client as any)).rejects.toThrow(
        'docker restart failed for container agentorchestrator-conv-fail',
      );
    });

    it('throws when health check fails after restart', async () => {
      const rt = new OpenCodeRuntime('docker', {
        binary: 'opencode',
        docker: { image: 'img', containerPort: 8080 },
      });
      const restartProc = createMockProc({ exitCode: 0 });
      (spawn as any).mockReturnValue(restartProc);

      const client = { health: vi.fn().mockRejectedValue(new Error('not healthy')) };

      await expect(rt.restart('conv-health-fail', client as any)).rejects.toThrow(
        'Container restart health check failed for conv-health-fail',
      );
    }, 15000);
  });
});
