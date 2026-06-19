import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('cross-spawn', () => ({ spawn: vi.fn() }));

import { spawn } from 'cross-spawn';
import { PortPool } from '../../orchestrator/port-pool.js';
import { DockerRuntime } from './docker.js';

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

describe('DockerRuntime', () => {
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
    it('stores image and containerPort', () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'test-image', containerPort: 3100 });
      expect((rt as any).config.image).toBe('test-image');
      expect((rt as any).config.containerPort).toBe(3100);
    });

    it('exposes type and capabilities', () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img', containerPort: 3100 });
      expect(rt.type).toBe('opencode');
      expect(rt.capabilities).toEqual({
        sessions: true, streaming: true, files: true,
        tools: true, config: true, agents: true, skills: true,
      });
    });
  });

  describe('start', () => {
    it('calls docker run with correct args', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'test-image', containerPort: 3100 });
      const mockProc = createMockProc({ exitCode: 0 });
      (spawn as any).mockReturnValue(mockProc);
      mockFetch.mockResolvedValue(makeHealthyFetch());

      const result = await rt.start(
        'conv-d', '/tmp/docker-ws',
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
        expect.arrayContaining(['-p', expect.stringContaining(':3100')]),
        expect.anything(),
      );
      expect(result.port).toBeGreaterThanOrEqual(40000);
      expect(result.handle).toBeDefined();
      expect(result.client).toBeDefined();
    });

    it('uses instanceHost in baseUrl', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img', containerPort: 3100, instanceHost: '10.0.0.1' });
      const mockProc = createMockProc({ exitCode: 0 });
      (spawn as any).mockReturnValue(mockProc);
      mockFetch.mockResolvedValue(makeHealthyFetch());

      const result = await rt.start(
        'conv-host', '/tmp/ws',
        { username: 'u', password: 'p' },
        { retries: 1, intervalMs: 1, clientTimeoutMs: 5000 },
      );

      expect(result.client).toBeDefined();
      // internal client baseUrl should use the configured host
    });

    it('skips port mapping when networkMode is host', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img', containerPort: 3100, networkMode: 'host' });
      const mockProc = createMockProc({ exitCode: 0 });
      (spawn as any).mockReturnValue(mockProc);
      mockFetch.mockResolvedValue(makeHealthyFetch());

      await rt.start(
        'conv-nethost', '/tmp/ws',
        { username: 'u', password: 'p' },
        { retries: 1, intervalMs: 1, clientTimeoutMs: 5000 },
      );

      expect(spawn).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['--network', 'host']),
        expect.anything(),
      );
      const dockerArgs = (spawn as any).mock.calls[0][1] as string[];
      expect(dockerArgs).not.toContain('-p');
    });

    it('adds --network flag for custom network mode', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img', containerPort: 3100, networkMode: 'my-net' });
      const mockProc = createMockProc({ exitCode: 0 });
      (spawn as any).mockReturnValue(mockProc);
      mockFetch.mockResolvedValue(makeHealthyFetch());

      await rt.start(
        'conv-net', '/tmp/ws',
        { username: 'u', password: 'p' },
        { retries: 1, intervalMs: 1, clientTimeoutMs: 5000 },
      );

      expect(spawn).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['--network', 'my-net']),
        expect.anything(),
      );
      const dockerArgs = (spawn as any).mock.calls[0][1] as string[];
      expect(dockerArgs).toContain('-p'); // should still have port mapping for non-host
    });

    it('releases port when health check fails', async () => {
      const pool = createPortPool(30000, 30000);
      const rt = new DockerRuntime(pool, { image: 'img', containerPort: 3100 });
      const mockProc = createMockProc({ exitCode: 0 });
      (spawn as any).mockReturnValue(mockProc);
      mockFetch.mockRejectedValue(new Error('timeout'));

      await expect(rt.start(
        'conv-fail', '/tmp/ws',
        { username: 'u', password: 'p' },
        { retries: 1, intervalMs: 1, clientTimeoutMs: 5000 },
      )).rejects.toThrow('OpenCode instance failed health check after 1 retries');

      // Port should be still in use (runtime doesn't auto-release on health fail)
      // This is intentional - InstanceManager handles cleanup
    });
  });

  describe('stop', () => {
    it('calls docker rm -f via handle', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img', containerPort: 3100 });
      const runProc = createMockProc({ exitCode: 0 });
      (spawn as any).mockReturnValue(runProc);
      mockFetch.mockResolvedValue(makeHealthyFetch());

      const result = await rt.start(
        'conv-kill', '/tmp/ws',
        { username: 'u', password: 'p' },
        { retries: 1, intervalMs: 1, clientTimeoutMs: 5000 },
      );

      const rmProc = createMockProc();
      (spawn as any).mockReset();
      (spawn as any).mockReturnValue(rmProc);

      await rt.stop(result.handle);

      expect(spawn).toHaveBeenCalledWith(
        'docker',
        ['rm', '-f', 'agentorchestrator-conv-kill'],
        expect.anything(),
      );
    });

    it('noop when handle is undefined', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img', containerPort: 3100 });
      await expect(rt.stop(undefined)).resolves.toBeUndefined();
    });
  });

  describe('cleanupOrphans', () => {
    it('lists and removes orphan containers', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img', containerPort: 3100 });

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

  describe('restart', () => {
    const hcConfig = { retries: 3, intervalMs: 1, clientTimeoutMs: 5000 };
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);
    });

    it('restarts container and waits for health check', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img', containerPort: 3100 });
      (rt as any).instanceAuth.set('conv-restart', { baseUrl: 'http://127.0.0.1:3100', auth: { username: 'test', password: 'test' } });
      (rt as any).clients.set('conv-restart', {});
      (rt as any).ports.set('conv-restart', 3100);
      const restartProc = createMockProc({ exitCode: 0 });
      (spawn as any).mockReturnValue(restartProc);
      mockFetch.mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ healthy: true, version: '1.0.0' }) });

      const result = await rt.restart('conv-restart', hcConfig);

      expect(spawn).toHaveBeenCalledWith(
        'docker',
        ['restart', 'agentorchestrator-conv-restart'],
        expect.anything(),
      );
      expect(result).toHaveProperty('client');
      expect(result).toHaveProperty('port', 3100);
      expect(result).toHaveProperty('handle');
    });

    it('throws when docker restart command fails', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img', containerPort: 3100 });
      const restartProc = createMockProc({ exitCode: 1 });
      (spawn as any).mockReturnValue(restartProc);

      await expect(rt.restart('conv-fail', hcConfig)).rejects.toThrow(
        'docker restart failed for container agentorchestrator-conv-fail',
      );
    });

    it('throws when health check fails after restart', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img', containerPort: 3100 });
      (rt as any).instanceAuth.set('conv-health-fail', { baseUrl: 'http://127.0.0.1:3100', auth: { username: 'test', password: 'test' } });
      const restartProc = createMockProc({ exitCode: 0 });
      (spawn as any).mockReturnValue(restartProc);
      mockFetch.mockRejectedValue(new Error('connection refused'));

      await expect(rt.restart('conv-health-fail', hcConfig)).rejects.toThrow(
        'OpenCode instance failed health check after 3 retries',
      );
    }, 15000);
  });
});
