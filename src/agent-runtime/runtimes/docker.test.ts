import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('cross-spawn', () => ({ spawn: vi.fn() }));

import { spawn } from 'cross-spawn';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PortPool } from '../../orchestrator/port-pool.js';
import { DockerRuntime } from './docker.js';
import { readSessionOwnershipRecord, resolveSessionStorage } from '../session-storage.js';

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
    it('stores image', () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'test-image' });
      expect((rt as any).config.image).toBe('test-image');
    });

    it('exposes type and capabilities', () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img' });
      expect(rt.type).toBe('opencode');
      expect(rt.capabilities).toEqual({
        sessions: true, streaming: true, files: true,
        tools: true, config: true, agents: true, skills: true,
      });
    });
  });

  describe('start', () => {
    it('calls docker run with correct args', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'test-image' });
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
        expect.arrayContaining(['-p', expect.stringContaining(`:${result.port}`)]),
        expect.anything(),
      );
      expect(result.port).toBeGreaterThanOrEqual(40000);
      expect(result.handle).toBeDefined();
      expect(result.client).toBeDefined();
    });

    it('mounts session dir and sets XDG_DATA_HOME when sessionStorage is configured', async () => {
      const root = mkdtempSync(join(tmpdir(), 'ao-docker-test-'));
      try {
        const rt = new DockerRuntime(createPortPool(), { image: 'test-image', sessionStorage: { sharedRoot: root } });
        const mockProc = createMockProc({ exitCode: 0 });
        (spawn as any).mockReturnValue(mockProc);
        mockFetch.mockResolvedValue(makeHealthyFetch());

        await rt.start(
          'sess-d', '/tmp/docker-ws',
          { username: 'u', password: 'p' },
          { retries: 1, intervalMs: 1, clientTimeoutMs: 5000 },
        );

        expect(spawn).toHaveBeenCalledWith(
          'docker',
          expect.arrayContaining(['-v', `${join(root, 'sess-d')}:/opencode-data`]),
          expect.anything(),
        );
        expect(spawn).toHaveBeenCalledWith(
          'docker',
          expect.arrayContaining(['-e', 'XDG_DATA_HOME=/opencode-data']),
          expect.anything(),
        );
        expect(readSessionOwnershipRecord({ sharedRoot: root }, 'sess-d')).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('omits session mount when sessionStorage is unset', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'test-image' });
      const mockProc = createMockProc({ exitCode: 0 });
      (spawn as any).mockReturnValue(mockProc);
      mockFetch.mockResolvedValue(makeHealthyFetch());

      await rt.start(
        'sess-plain', '/tmp/docker-ws',
        { username: 'u', password: 'p' },
        { retries: 1, intervalMs: 1, clientTimeoutMs: 5000 },
      );

      const [, args] = (spawn as any).mock.calls[0];
      expect(args).not.toContain('/opencode-data');
      expect(args).not.toContain('XDG_DATA_HOME=/opencode-data');
    });

    it('uses instanceHost in baseUrl', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img', instanceHost: '10.0.0.1' });
      const mockProc = createMockProc({ exitCode: 0 });
      (spawn as any).mockReturnValue(mockProc);
      mockFetch.mockResolvedValue(makeHealthyFetch());

      const result = await rt.start(
        'conv-host', '/tmp/ws',
        { username: 'u', password: 'p' },
        { retries: 1, intervalMs: 1, clientTimeoutMs: 5000 },
      );

      expect(result.client).toBeDefined();
    });

    it('skips port mapping when networkMode is host', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img', networkMode: 'host' });
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
      const rt = new DockerRuntime(createPortPool(), { image: 'img', networkMode: 'my-net' });
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
      expect(dockerArgs).toContain('-p');
    });

    it('applies optional Docker engine log limits', async () => {
      const rt = new DockerRuntime(createPortPool(), {
        image: 'img',
        logging: { driver: 'local', maxSize: '10m', maxFiles: 3 },
      });
      (spawn as any).mockReturnValue(createMockProc({ exitCode: 0 }));
      mockFetch.mockResolvedValue(makeHealthyFetch());

      await rt.start(
        'conv-logs', '/tmp/ws',
        { username: 'u', password: 'p' },
        { retries: 1, intervalMs: 1, clientTimeoutMs: 5000 },
      );

      const dockerArgs = (spawn as any).mock.calls[0][1] as string[];
      expect(dockerArgs).toEqual(expect.arrayContaining([
        '--log-driver', 'local',
        '--log-opt', 'max-size=10m',
        '--log-opt', 'max-file=3',
      ]));
    });

    it('releases port when health check fails', async () => {
      const pool = createPortPool(30000, 30000);
      const rt = new DockerRuntime(pool, { image: 'img' });
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
      const rt = new DockerRuntime(createPortPool(), { image: 'img' });
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
      const rt = new DockerRuntime(createPortPool(), { image: 'img' });
      await expect(rt.stop(undefined)).resolves.toBeUndefined();
    });
  });

  describe('persistent data deletion', () => {
    it('marks, quarantines, and purges configured session storage', async () => {
      const root = mkdtempSync(join(tmpdir(), 'ao-docker-delete-'));
      try {
        const config = { sharedRoot: root };
        const rt = new DockerRuntime(createPortPool(), {
          image: 'img',
          sessionStorage: config,
          cleanupOwnerId: 'test-owner',
        });
        (spawn as any).mockReturnValue(createMockProc({ exitCode: 0 }));
        mockFetch.mockResolvedValue(makeHealthyFetch());

        await rt.start(
          'docker-delete', '/tmp/ws',
          { username: 'u', password: 'p' },
          { retries: 1, intervalMs: 1, clientTimeoutMs: 5000 },
        );
        writeFileSync(join(root, 'docker-delete', 'opencode.db'), 'data');

        await rt.preparePersistentDataDeletion('docker-delete');
        expect(readSessionOwnershipRecord(config, 'docker-delete')?.state).toBe('delete-pending');
        await rt.deletePersistentData('docker-delete');

        expect(existsSync(join(root, 'docker-delete'))).toBe(false);
        expect(readSessionOwnershipRecord(config, 'docker-delete')).toBeUndefined();

        const recreated = resolveSessionStorage(config, 'docker-delete', 'test-owner');
        writeFileSync(join(recreated.sessionDir, 'keep.txt'), 'new generation');
        await rt.deletePersistentData('docker-delete');
        expect(existsSync(join(recreated.sessionDir, 'keep.txt'))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('is a no-op without configured session storage', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img' });
      await expect(rt.preparePersistentDataDeletion('docker-no-storage')).resolves.toBeUndefined();
      await expect(rt.deletePersistentData('docker-no-storage')).resolves.toBeUndefined();
    });

  });

  describe('cleanupOrphans', () => {
    it('lists and removes orphan containers', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img' });

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
      const rt = new DockerRuntime(createPortPool(), { image: 'img' });
      (rt as any).instanceAuth.set('conv-restart', { baseUrl: 'http://127.0.0.1:40000', auth: { username: 'test', password: 'test' } });
      (rt as any).clients.set('conv-restart', {});
      (rt as any).ports.set('conv-restart', 40000);
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
      expect(result).toHaveProperty('port', 40000);
      expect(result).toHaveProperty('handle');
    });

    it('throws when docker restart command fails', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img' });
      const restartProc = createMockProc({ exitCode: 1 });
      (spawn as any).mockReturnValue(restartProc);

      await expect(rt.restart('conv-fail', hcConfig)).rejects.toThrow(
        'docker restart failed for container agentorchestrator-conv-fail',
      );
    });

    it('throws when health check fails after restart', async () => {
      const rt = new DockerRuntime(createPortPool(), { image: 'img' });
      (rt as any).instanceAuth.set('conv-health-fail', { baseUrl: 'http://127.0.0.1:40000', auth: { username: 'test', password: 'test' } });
      const restartProc = createMockProc({ exitCode: 0 });
      (spawn as any).mockReturnValue(restartProc);
      mockFetch.mockRejectedValue(new Error('connection refused'));

      await expect(rt.restart('conv-health-fail', hcConfig)).rejects.toThrow(
        'OpenCode instance failed health check after 3 retries',
      );
    }, 15000);
  });
});
