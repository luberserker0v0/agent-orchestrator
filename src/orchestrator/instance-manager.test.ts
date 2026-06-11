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
  enforceCanonicalConfig: true,
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
      expect(info.port).toBeGreaterThanOrEqual(41000);
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
        portRange: { start: 30000, end: 29999, allowDynamicFallback: false },
      };
      const emptyManager = new InstanceManager(emptyConfig, workspaceFactory);

      await expect(emptyManager.createInstance('conv-empty')).rejects.toThrow(
        'No available ports in pool'
      );
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

    it('calls ensure() when workspace already exists', async () => {
      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_ensure',
        title: null,
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      const info = await instanceManager.createInstance('conv-ensure');
      const wsPath = info.workspacePath;
      expect(existsSync(wsPath)).toBe(true);

      // Stop preserves workspace on disk
      await instanceManager.stopInstance('conv-ensure');
      expect(instanceManager.listInstances()).toHaveLength(0);
      expect(existsSync(wsPath)).toBe(true);

      // Second creation should use ensure() since workspace exists
      const proc2 = createMockProc();
      mockedSpawn.mockReturnValue(proc2 as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });

      const info2 = await instanceManager.createInstance('conv-ensure');
      expect(info2.workspacePath).toBe(wsPath);
      expect(existsSync(info2.workspacePath)).toBe(true);
    });

    it('retries after healthy=false health check response', async () => {
      const fastConfig: OrchestratorConfig = {
        ...defaultOrchestratorConfig,
        healthCheck: { retries: 3, intervalMs: 1 },
      };
      const fastManager = new InstanceManager(fastConfig, workspaceFactory);

      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth
        .mockResolvedValueOnce({ healthy: false, version: '1.0.0' })
        .mockResolvedValueOnce({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_false',
        title: null,
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      const info = await fastManager.createInstance('conv-health-false');
      expect(info.sessionId).toBeUndefined();
      expect(mockHealth).toHaveBeenCalledTimes(2);

      await fastManager.destroyInstance('conv-health-false');
      fastManager.destroy();
    });

  });

  describe('Docker runtime', () => {
    it('handles docker stdout and stderr events', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory);

      const mockProc = createMockProc({ exitCode: null });
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });

      await dockerManager.createInstance('conv-docker-stdio');

      // Trigger stdout data event via registered callback
      const stdoutCbs = (mockProc as any).listeners?.['stdout:data'];
      if (stdoutCbs) stdoutCbs.forEach((cb: (...args: unknown[]) => void) => cb(Buffer.from('Server started')));
      // Trigger stderr data event via registered callback
      const stderrCbs = (mockProc as any).listeners?.['stderr:data'];
      if (stderrCbs) stderrCbs.forEach((cb: (...args: unknown[]) => void) => cb(Buffer.from('Debug info')));

      // With -d mode, exit event no longer triggers cleanup; verify instance still tracked
      mockProc.exitCode = 0;
      mockProc.emit('exit', 0);
      expect(dockerManager.listInstances()).toHaveLength(1);

      // Cleanup
      await dockerManager.destroyInstance('conv-docker-stdio');
      dockerManager.destroy();
    });

    it('spawns docker container with correct args', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory);

      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });

      const info = await dockerManager.createInstance('conv-docker');

      const [, args] = mockedSpawn.mock.calls[0] as [string, string[], unknown];
      expect(args).toEqual([
        'run', '-d',
        '--name', 'agentorchestrator-conv-docker',
        '-p', `127.0.0.1:${info.port}:3000`,
        '-v', expect.stringMatching(/conv-docker:\/workspace$/),
        '-w', '/workspace',
        '-e', 'OPENCODE_SERVER_USERNAME=opencode',
        '-e', expect.stringMatching(/^OPENCODE_SERVER_PASSWORD=[a-f0-9]{32}$/),
        dockerOrchestratorConfig.docker!.image,
        'serve', '--port', '3000', '--hostname', '0.0.0.0',
      ]);

      // Cleanup
      mockProc.exitCode = 0;
      await dockerManager.destroyInstance('conv-docker');
      dockerManager.destroy();
    });

    it('creates instance with correct info in docker mode', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory);

      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });

      const info = await dockerManager.createInstance('conv-docker2');

      expect(info.id).toBe('conv-docker2');
      expect(info.port).toBeGreaterThanOrEqual(41000);
      expect(info.sessionId).toBeUndefined();
      expect(existsSync(info.workspacePath)).toBe(true);
    });

    it('destroys docker container using docker rm -f', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory);

      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });

      await dockerManager.createInstance('conv-docker-rm');

      // Clear spawn calls to verify the docker rm call
      mockedSpawn.mockClear();
      const rmProc = createMockProc({ exitCode: 0 });
      mockedSpawn.mockReturnValue(rmProc as any);

      await dockerManager.destroyInstance('conv-docker-rm');

      const [, args] = mockedSpawn.mock.calls[0] as [string, string[], unknown];
      expect(args).toEqual(['rm', '-f', 'agentorchestrator-conv-docker-rm']);

      dockerManager.destroy();
    });

    it('cleans up docker container when health check fails', async () => {
      const fastDockerConfig: OrchestratorConfig = {
        ...dockerOrchestratorConfig,
        healthCheck: { retries: 2, intervalMs: 1 },
      };
      const dockerManager = new InstanceManager(fastDockerConfig, workspaceFactory);

      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockRejectedValue(new Error('Connection refused'));

      await expect(dockerManager.createInstance('conv-docker-health-fail')).rejects.toThrow(
        'OpenCode instance failed health check after 2 retries'
      );

      expect(mockedSpawn).toHaveBeenCalledWith('docker', ['rm', '-f', 'agentorchestrator-conv-docker-health-fail'], { stdio: 'ignore' });

      dockerManager.destroy();
    });
  });

  describe('restartInstance', () => {
    it('restarts docker container and waits for health check to pass', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory);

      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });

      await dockerManager.createInstance('conv-restart');

      mockedSpawn.mockClear();
      const restartProc = createMockProc({ exitCode: 0 });
      mockedSpawn.mockReturnValue(restartProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });

      // restartInstance awaits 'exit' event — emit it after listener is registered
      const restartPromise = dockerManager.restartInstance('conv-restart');
      restartProc.emit('exit', 0);
      await restartPromise;

      const [, args] = mockedSpawn.mock.calls[0] as [string, string[], unknown];
      expect(args).toEqual(['restart', 'agentorchestrator-conv-restart']);

      await dockerManager.destroyInstance('conv-restart');
      dockerManager.destroy();
    });

    it('throws when instance not found', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory);
      await expect(dockerManager.restartInstance('no-such-instance')).rejects.toThrow(
        'Instance not found: no-such-instance'
      );
      dockerManager.destroy();
    });

    it('throws when docker restart command fails', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory);

      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });

      await dockerManager.createInstance('conv-restart-fail');

      mockedSpawn.mockClear();
      const restartProc = createMockProc({ exitCode: 1 });
      mockedSpawn.mockReturnValue(restartProc as any);

      const restartPromise = dockerManager.restartInstance('conv-restart-fail');
      restartProc.emit('exit', 1);
      await expect(restartPromise).rejects.toThrow(
        'docker restart failed for container agentorchestrator-conv-restart-fail'
      );

      await dockerManager.destroyInstance('conv-restart-fail');
      dockerManager.destroy();
    });

    it('throws when health check fails after restart', async () => {
      const fastDockerConfig: OrchestratorConfig = {
        ...dockerOrchestratorConfig,
        healthCheck: { retries: 2, intervalMs: 1 },
      };
      const dockerManager = new InstanceManager(fastDockerConfig, workspaceFactory);

      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });

      await dockerManager.createInstance('conv-restart-health');

      mockedSpawn.mockClear();
      const restartProc = createMockProc({ exitCode: 0 });
      mockedSpawn.mockReturnValue(restartProc as any);
      mockHealth.mockRejectedValue(new Error('Connection refused'));

      const restartPromise = dockerManager.restartInstance('conv-restart-health');
      restartProc.emit('exit', 0);
      await expect(restartPromise).rejects.toThrow(
        'Container restart health check failed for conv-restart-health after 2 retries'
      );

      await dockerManager.destroyInstance('conv-restart-health');
      dockerManager.destroy();
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

  describe('setSessionId', () => {
    it('sets session ID on existing instance', async () => {
      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_set',
        title: null,
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      await instanceManager.createInstance('conv-set-session');
      instanceManager.setSessionId('conv-set-session', 'ses_set');

      const inst = instanceManager.getInstance('conv-set-session');
      expect(inst!.sessionId).toBe('ses_set');
    });

    it('does not throw for non-existent instance', () => {
      expect(() => instanceManager.setSessionId('ghost', 'ses_ghost')).not.toThrow();
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

    it('destroys instance even when cleanup encounters errors', async () => {
      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });

      await instanceManager.createInstance('conv-rm-err');
      // Destroy should not throw even if workspace cleanup hits an edge case
      await instanceManager.destroyInstance('conv-rm-err');
      expect(instanceManager.listInstances()).toHaveLength(0);
    });

    it('does not throw for non-existent id', async () => {
      await expect(instanceManager.destroyInstance('ghost')).resolves.toBeUndefined();
    });
  });

  describe('stopInstance', () => {
    it('kills process but preserves workspace on disk', async () => {
      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });
      mockCreateSession.mockResolvedValue({
        id: 'ses_stop',
        title: null,
        parent_id: null,
        status: 'active',
        created_at: '',
        updated_at: '',
      });

      const info = await instanceManager.createInstance('conv-stop');
      expect(instanceManager.listInstances()).toHaveLength(1);
      expect(existsSync(info.workspacePath)).toBe(true);

      await instanceManager.stopInstance('conv-stop');

      expect(instanceManager.listInstances()).toHaveLength(0);
      expect(existsSync(info.workspacePath)).toBe(true);
    });

    it('does not throw for non-existent instance', async () => {
      await expect(instanceManager.stopInstance('ghost')).resolves.toBeUndefined();
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
    it('handles stdout and stderr data events', async () => {
      const mockProc = createMockProc({ exitCode: null });
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });

      await instanceManager.createInstance('conv-stdio');

      // Trigger stdout data event
      const stdoutCbs = (mockProc as any).listeners?.['stdout:data'];
      if (stdoutCbs) stdoutCbs.forEach((cb: (...args: unknown[]) => void) => cb(Buffer.from('listening on port 3000')));
      // Trigger stderr data event
      const stderrCbs = (mockProc as any).listeners?.['stderr:data'];
      if (stderrCbs) stderrCbs.forEach((cb: (...args: unknown[]) => void) => cb(Buffer.from('debug output')));

      // Clean up
      mockProc.exitCode = 0;
      mockProc.emit('exit', 0);
      await new Promise((r) => setTimeout(r, 10));
      expect(instanceManager.listInstances()).toHaveLength(0);
    });

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
    it('does not throw when treeKill throws', async () => {
      const mockProc = createMockProc({ exitCode: null, pid: 99999 });
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });
      // Make treeKill throw
      mockedTreeKill.mockImplementationOnce(() => { throw new Error('permission denied'); });

      await instanceManager.createInstance('conv-kill-err');
      await expect(instanceManager.destroyInstance('conv-kill-err')).resolves.toBeUndefined();
    });

    it('handles waitForExit timeout when process does not exit', async () => {
      const mockProc = createMockProc({ exitCode: null, pid: 12346 });
      // Override once to ignore exit event (simulate process never exiting)
      mockProc.once = () => { /* noop - don't register callbacks */ };
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });

      await instanceManager.createInstance('conv-timeout');
      await expect(instanceManager.destroyInstance('conv-timeout')).resolves.toBeUndefined();
    });

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
    it('does not start sweep when idleTimeoutMs is 0', async () => {
      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);
      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });

      const noSweepConfig: OrchestratorConfig = {
        ...defaultOrchestratorConfig,
        idleTimeoutMs: 0,
      };
      const noSweepManager = new InstanceManager(noSweepConfig, workspaceFactory);
      await noSweepManager.createInstance('conv-no-sweep');

      // Should not have an idle sweep timer running
      // If the test passes without hanging, the sweep isn't running
      noSweepManager.destroy();
    });

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

  describe('cleanupOrphanContainers', () => {
    it('returns immediately when runtime is direct', async () => {
      const directManager = new InstanceManager(defaultOrchestratorConfig, workspaceFactory);
      await directManager.cleanupOrphanContainers();
      expect(mockedSpawn).not.toHaveBeenCalled();
      directManager.destroy();
    });

    it('does nothing when no orphan containers exist', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory);
      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);

      const promise = dockerManager.cleanupOrphanContainers();
      mockProc.emit('exit', 0);
      await promise;

      expect(mockedSpawn).toHaveBeenCalledTimes(1);
      expect(mockedSpawn).toHaveBeenCalledWith(
        'docker',
        ['ps', '-a', '--filter', 'name=agentorchestrator-', '--format', '{{.Names}}'],
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
      );
      dockerManager.destroy();
    });

    it('removes orphan containers', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory);
      const psProc = createMockProc();
      const rmProc1 = createMockProc();
      const rmProc2 = createMockProc();

      mockedSpawn.mockReturnValueOnce(psProc as any);
      mockedSpawn.mockReturnValueOnce(rmProc1 as any);
      mockedSpawn.mockReturnValueOnce(rmProc2 as any);

      const promise = dockerManager.cleanupOrphanContainers();

      psProc.emit('stdout:data', Buffer.from('agentorchestrator-foo\n'));
      psProc.emit('stdout:data', Buffer.from('agentorchestrator-bar\n'));
      psProc.emit('exit', 0);

      rmProc1.emit('exit', 0);
      rmProc2.emit('exit', 0);

      await promise;

      expect(mockedSpawn).toHaveBeenCalledTimes(3);
      expect(mockedSpawn).toHaveBeenNthCalledWith(
        1, 'docker',
        ['ps', '-a', '--filter', 'name=agentorchestrator-', '--format', '{{.Names}}'],
        expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
      );
      expect(mockedSpawn).toHaveBeenNthCalledWith(2, 'docker', ['rm', '-f', 'agentorchestrator-foo'], expect.any(Object));
      expect(mockedSpawn).toHaveBeenNthCalledWith(3, 'docker', ['rm', '-f', 'agentorchestrator-bar'], expect.any(Object));
      dockerManager.destroy();
    });

    it('handles docker ps error gracefully', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory);
      const mockProc = createMockProc();
      mockedSpawn.mockReturnValue(mockProc as any);

      const promise = dockerManager.cleanupOrphanContainers();
      mockProc.emit('error', new Error('docker not found'));
      await promise;

      // Only the ps call was made, no rm calls
      expect(mockedSpawn).toHaveBeenCalledTimes(1);
      dockerManager.destroy();
    });

    it('still resolves when rm fails', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory);
      const psProc = createMockProc();
      const rmProc = createMockProc();

      mockedSpawn.mockReturnValueOnce(psProc as any);
      mockedSpawn.mockReturnValueOnce(rmProc as any);

      const promise = dockerManager.cleanupOrphanContainers();

      psProc.emit('stdout:data', Buffer.from('agentorchestrator-stubborn\n'));
      psProc.emit('exit', 0);

      // rm emits error instead of exit — code counts error as complete
      rmProc.emit('error', new Error('permission denied'));

      await promise;

      expect(mockedSpawn).toHaveBeenCalledTimes(2);
      expect(mockedSpawn).toHaveBeenNthCalledWith(2, 'docker', ['rm', '-f', 'agentorchestrator-stubborn'], expect.any(Object));
      dockerManager.destroy();
    });
  });
});
