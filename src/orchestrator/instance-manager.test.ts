import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { InstanceManager } from './instance-manager.js';
import { WorkspaceFactory } from './workspace-factory.js';
import type { OrchestratorConfig, WorkspaceConfig } from '../config-loader.js';
import { defaultOrchestratorConfig, dockerOrchestratorConfig } from '../test-fixtures/ao-configs.js';

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock('cross-spawn', async () => {
  return { spawn: vi.fn() };
});

vi.mock('tree-kill', async () => {
  return { default: vi.fn() };
});

vi.mock('../opencode-http/client.js', async () => {
  return { OpenCodeClient: vi.fn() };
});

import { spawn } from 'cross-spawn';
import treeKill from 'tree-kill';
import { OpenCodeClient } from '../opencode-http/client.js';

// ── Helpers ─────────────────────────────────────────────────────────

const TEST_BASE_PATH = join(process.cwd(), 'test-workspace-im');

function cleanup(): void {
  if (existsSync(TEST_BASE_PATH)) {
    rmSync(TEST_BASE_PATH, { recursive: true, force: true });
  }
}

function createMockProc(opts: { exitCode?: number | null; pid?: number | undefined } = {}) {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  return {
    pid: 'pid' in opts ? opts.pid : 12345,
    killed: false,
    exitCode: opts.exitCode ?? 0,
    stdout: {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        const key = `stdout:${event}`;
        if (!listeners[key]) listeners[key] = [];
        listeners[key].push(cb);
      },
    },
    stderr: {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        const key = `stderr:${event}`;
        if (!listeners[key]) listeners[key] = [];
        listeners[key].push(cb);
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
        if (idx !== undefined && idx > -1) {
          listeners[event].splice(idx, 1);
        }
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

const workspaceConfig: WorkspaceConfig = {
  basePath: 'test-workspace-im',
  defaultPermissions: {},
};

// ── Tests ─────────────────────────────────────────────────────────────

describe('InstanceManager', () => {
  let workspaceFactory: WorkspaceFactory;
  let instanceManager: InstanceManager;
  let mockedSpawn: ReturnType<typeof vi.mocked<typeof spawn>>;
  let mockedTreeKill: ReturnType<typeof vi.mocked<typeof treeKill>>;
  let mockedOpenCodeClient: ReturnType<typeof vi.mocked<typeof OpenCodeClient>>;
  let mockHealth: ReturnType<typeof vi.fn>;
  let mockCreateSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cleanup();
    workspaceFactory = new WorkspaceFactory(workspaceConfig);
    instanceManager = new InstanceManager(defaultOrchestratorConfig, workspaceFactory);

    mockedSpawn = vi.mocked(spawn);
    mockedTreeKill = vi.mocked(treeKill as any);
    mockedOpenCodeClient = vi.mocked(OpenCodeClient);

    mockHealth = vi.fn();
    mockCreateSession = vi.fn();

    mockedOpenCodeClient.mockImplementation(function () {
      return {
        health: mockHealth,
        createSession: mockCreateSession,
      };
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('createInstance', () => {
    it('creates instance with all lifecycle steps', async () => {
      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_test',
        title: 'AgentOrchestrator-test',
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      const info = await instanceManager.createInstance('conv-001');

      expect(info.id).toBe('conv-001');
      expect(info.port).toBe(30000);
      expect(info.sessionId).toBeUndefined();
      expect(existsSync(info.workspacePath)).toBe(true);
    });

    it('throws when instance already exists', async () => {
      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_1',
        title: null,
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      await instanceManager.createInstance('conv-dup');

      await expect(instanceManager.createInstance('conv-dup')).rejects.toThrow(
        'Instance already exists: conv-dup'
      );
    });

    it('throws when no ports available and no instances to evict', async () => {
      const emptyConfig: OrchestratorConfig = {
        ...defaultOrchestratorConfig,
        portRange: { start: 30000, end: 29999 },
      };
      const emptyManager = new InstanceManager(emptyConfig, workspaceFactory);

      await expect(emptyManager.createInstance('conv-empty')).rejects.toThrow(
        'No available ports in pool'
      );
    });

    it('evicts LRU instance when port pool exhausted', async () => {
      const tinyConfig: OrchestratorConfig = {
        ...defaultOrchestratorConfig,
        portRange: { start: 30000, end: 30000 },
      };
      const tinyManager = new InstanceManager(tinyConfig, workspaceFactory);

      const procA = createMockProc();
      mockedSpawn.mockReturnValue(procA as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_1',
        title: null,
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      await tinyManager.createInstance('conv-old');
      expect(tinyManager.listInstances()).toHaveLength(1);

      // Second creation should evict the first one
      const procB = createMockProc();
      mockedSpawn.mockReturnValue(procB as any);
      await tinyManager.createInstance('conv-new');

      const list = tinyManager.listInstances();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('conv-new');
    });

    it('throws and releases port when workspace creation fails', async () => {
      const badFactory = {
        create: vi.fn().mockImplementation(() => {
          throw new Error('disk full');
        }),
        destroy: vi.fn(),
        hasWorkspace: vi.fn().mockReturnValue(false),
        ensure: vi.fn(),
      } as any;

      const manager = new InstanceManager(defaultOrchestratorConfig, badFactory);
      await expect(manager.createInstance('conv-fail')).rejects.toThrow('disk full');
    });

    it('throws when health check fails after retries', async () => {
      const mockProc = createMockProc({ exitCode: null });
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockRejectedValue(new Error('Connection refused'));

      // Use a tight healthCheck config so this test doesn't wait long
      const fastFailConfig = { ...defaultOrchestratorConfig, healthCheck: { retries: 2, intervalMs: 1 } };
      const fastFailManager = new InstanceManager(fastFailConfig, workspaceFactory);

      await expect(fastFailManager.createInstance('conv-health-fail')).rejects.toThrow(
        'OpenCode instance failed health check after 2 retries'
      );
    });

    it('succeeds on second health check attempt', async () => {
      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth
        .mockRejectedValueOnce(new Error('Not ready'))
        .mockResolvedValueOnce({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_retry',
        title: null,
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      const info = await instanceManager.createInstance('conv-retry');
      expect(info.sessionId).toBeUndefined();
      expect(mockHealth).toHaveBeenCalledTimes(2);
    });

  });

  describe('Docker runtime', () => {
    it('spawns docker container with correct args', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory);

      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });

      await dockerManager.createInstance('conv-docker');

      const [, args] = mockedSpawn.mock.calls[0] as [string, string[], unknown];
      expect(args).toEqual([
        'run', '--rm',
        '-p', '127.0.0.1:30000:3000',
        '-v', expect.stringMatching(/conv-docker:\/workspace$/),
        '-w', '/workspace',
        '-e', 'OPENCODE_SERVER_USERNAME=opencode',
        '-e', expect.stringMatching(/^OPENCODE_SERVER_PASSWORD=[a-f0-9]{32}$/),
        dockerOrchestratorConfig.docker!.image,
        'serve', '--port', '3000', '--hostname', '0.0.0.0',
      ]);
    });

    it('creates instance with correct info in docker mode', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory);

      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });

      const info = await dockerManager.createInstance('conv-docker2');

      expect(info.id).toBe('conv-docker2');
      expect(info.port).toBe(30000);
      expect(info.sessionId).toBeUndefined();
      expect(existsSync(info.workspacePath)).toBe(true);
    });
  });

  describe('getInstance', () => {
    it('updates lastUsedAt on getInstance', async () => {
      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_get',
        title: null,
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      const before = Date.now();
      await instanceManager.createInstance('conv-get');
      const inst = instanceManager.getInstance('conv-get');
      expect(inst!.lastUsedAt).toBeGreaterThanOrEqual(before);
    });

    it('returns undefined for non-existent instance', () => {
      expect(instanceManager.getInstance('no-one')).toBeUndefined();
    });
  });

  describe('destroyInstance', () => {
    it('destroys instance and cleans up resources', async () => {
      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_del',
        title: null,
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      const info = await instanceManager.createInstance('conv-del');
      expect(instanceManager.listInstances()).toHaveLength(1);
      expect(existsSync(info.workspacePath)).toBe(true);

      await instanceManager.destroyInstance('conv-del');

      expect(instanceManager.listInstances()).toHaveLength(0);
      expect(existsSync(info.workspacePath)).toBe(false);
    });

    it('does not throw for non-existent id', async () => {
      await expect(instanceManager.destroyInstance('ghost')).resolves.toBeUndefined();
    });
  });

  describe('listInstances', () => {
    it('returns correct subset of fields', async () => {
      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_list',
        title: null,
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      await instanceManager.createInstance('conv-list');
      const list = instanceManager.listInstances();

      expect(list).toHaveLength(1);
      expect(list[0]).toHaveProperty('id', 'conv-list');
      expect(list[0]).toHaveProperty('port');
      expect(list[0]).toHaveProperty('lastUsedAt');
      expect(list[0]).not.toHaveProperty('workspacePath');
      expect(list[0]).not.toHaveProperty('process');
    });

    it('returns empty array when no instances', () => {
      expect(instanceManager.listInstances()).toEqual([]);
    });
  });

  describe('process events', () => {
    it('cleans up instance on process exit event', async () => {
      const mockProc = createMockProc({ exitCode: null });
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_exit',
        title: null,
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      await instanceManager.createInstance('conv-exit');
      expect(instanceManager.listInstances()).toHaveLength(1);

      mockProc.exitCode = 0;
      mockProc.emit('exit', 0);

      // Give async cleanup a tick to run
      await new Promise((r) => setTimeout(r, 10));
      expect(instanceManager.listInstances()).toHaveLength(0);
    });

    it('cleans up instance on process error event', async () => {
      const mockProc = createMockProc({ exitCode: null });
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_err',
        title: null,
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      await instanceManager.createInstance('conv-err');
      expect(instanceManager.listInstances()).toHaveLength(1);

      mockProc.exitCode = 1;
      mockProc.emit('error', new Error('spawn error'));

      await new Promise((r) => setTimeout(r, 10));
      expect(instanceManager.listInstances()).toHaveLength(0);
    });
  });

  describe('safeKill edge cases', () => {
    it('does not throw when process already exited', async () => {
      const mockProc = createMockProc({ exitCode: 0 });
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_safe1',
        title: null,
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      const info = await instanceManager.createInstance('conv-safe1');
      expect(info.process.exitCode).toBe(0);

      await instanceManager.destroyInstance('conv-safe1');
      expect(mockedTreeKill).not.toHaveBeenCalled();
    });

    it('does not throw when process pid is undefined', async () => {
      const mockProc = createMockProc({ exitCode: null, pid: undefined });
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_safe2',
        title: null,
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      await instanceManager.createInstance('conv-safe2');
      expect(mockedSpawn.mock.results[0].value.pid).toBeUndefined();

      await instanceManager.destroyInstance('conv-safe2');
      expect(mockedTreeKill).not.toHaveBeenCalled();
    });
  });

  describe('maxInstances strict enforcement', () => {
    it('evicts LRU when maxInstances is reached', async () => {
      const strictConfig: OrchestratorConfig = {
        ...defaultOrchestratorConfig,
        maxInstances: 1,
        portRange: { start: 30000, end: 30001 },
      };
      const strictManager = new InstanceManager(strictConfig, workspaceFactory);

      const procA = createMockProc();
      mockedSpawn.mockReturnValue(procA as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_1',
        title: null,
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      await strictManager.createInstance('conv-first');
      expect(strictManager.listInstances()).toHaveLength(1);
      expect(strictManager.listInstances()[0].id).toBe('conv-first');

      // Creating a second instance should evict the first one
      const procB = createMockProc();
      mockedSpawn.mockReturnValue(procB as any);
      await strictManager.createInstance('conv-second');

      const list = strictManager.listInstances();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('conv-second');
    });
  });

  describe('idle timeout sweep', () => {
    it('destroys idle instance after timeout', async () => {
      const idleConfig: OrchestratorConfig = {
        ...defaultOrchestratorConfig,
        idleTimeoutMs: 100,
        idleSweepIntervalMs: 50,
      };
      const idleManager = new InstanceManager(idleConfig, workspaceFactory);

      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_idle',
        title: null,
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      await idleManager.createInstance('conv-idle');
      expect(idleManager.listInstances()).toHaveLength(1);

      // Wait for idle timeout + sweep interval to pass
      await new Promise((r) => setTimeout(r, 250));

      expect(idleManager.listInstances()).toHaveLength(0);
      idleManager.destroy();
    });
  });

  describe('destroy', () => {
    it('clears idle sweep timer without error', () => {
      const manager = new InstanceManager(defaultOrchestratorConfig, workspaceFactory);
      expect(() => manager.destroy()).not.toThrow();
      // Calling destroy twice should also be safe
      expect(() => manager.destroy()).not.toThrow();
    });
  });
});
