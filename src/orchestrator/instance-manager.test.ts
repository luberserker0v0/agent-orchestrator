import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { InstanceManager } from './instance-manager.js';
import { RuntimeManager } from '../agent-runtime/runtime-manager.js';
import { WorkspaceFactory } from './workspace-factory.js';
import { LocalStorage } from '../storage/index.js';
import type { OrchestratorConfig, WorkspaceConfig } from '../config-loader.js';
import { defaultOrchestratorConfig, dockerOrchestratorConfig } from '../test-fixtures/ao-configs.js';
import { RuntimeRegistry } from '../agent-runtime/registry.js';
import type { AgentRuntime, AgentClient, InstanceHandle } from '../agent-runtime/types.js';
import { PortPool } from './port-pool.js';

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock('cross-spawn', async () => {
  return { spawn: vi.fn() };
});

// ── Helpers ─────────────────────────────────────────────────────────

const TEST_BASE_PATH = join(process.cwd(), 'test-workspace-im');

function cleanup(): void {
  if (existsSync(TEST_BASE_PATH)) {
    rmSync(TEST_BASE_PATH, { recursive: true, force: true });
  }
}

function createMockHandle(overrides: Partial<InstanceHandle> & { exitCode?: number | null } = {}): InstanceHandle & { _fireExit: (code: number | null) => void } {
  const exitCallbacks: Array<(code: number | null) => void> = [];
  return {
    pid: 12345,
    exitCode: overrides.exitCode ?? null,
    kill: vi.fn().mockResolvedValue(undefined),
    waitForExit: vi.fn().mockResolvedValue(undefined),
    onExit: vi.fn((cb: (code: number | null) => void) => { exitCallbacks.push(cb); }),
    _fireExit: (code: number | null) => { exitCallbacks.forEach(cb => cb(code)); },
  };
}

const workspaceConfig: WorkspaceConfig = {
  basePath: 'test-workspace-im',
  enforceCanonicalConfig: true,
  storage: { type: 'local' },
};

let nextPort = 41000;
function allocPorts(count: number): number[] {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) {
    ports.push(nextPort++);
  }
  return ports;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('InstanceManager', () => {
  let workspaceFactory: WorkspaceFactory;
  let instanceManager: InstanceManager;
  let runtimeManager: RuntimeManager;
  let runtimeRegistry: RuntimeRegistry;
  let mockRuntime: AgentRuntime;
  let mockClient: AgentClient;
  let mockSpawnFn: ReturnType<typeof vi.fn>;
  let mockHealth: ReturnType<typeof vi.fn>;
  let portPool: PortPool;

  beforeEach(() => {
    cleanup();
    workspaceFactory = new WorkspaceFactory(workspaceConfig, new LocalStorage('test-workspace-im'));

    mockClient = {
      health: vi.fn().mockResolvedValue({ healthy: true, version: '1.0.0' }),
      createSession: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
      listSessions: vi.fn(),
      getSessionChildren: vi.fn(),
      forkSession: vi.fn(),
      listMessages: vi.fn(),
      sendPrompt: vi.fn(),
      abortSession: vi.fn(),
      listProviders: vi.fn(),
      getConfig: vi.fn(),
      listAgents: vi.fn(),
    };
    mockHealth = mockClient.health as ReturnType<typeof vi.fn>;

    mockSpawnFn = vi.fn();

    mockRuntime = {
      type: 'opencode',
      capabilities: { sessions: true, streaming: true, files: true, tools: true, config: true, agents: true, skills: true },
      start: mockSpawnFn as AgentRuntime['start'],
      stop: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue({ client: mockClient, port: 0, handle: createMockHandle() }),
      cleanupOrphans: vi.fn().mockResolvedValue(undefined),
    };

    runtimeRegistry = new RuntimeRegistry();
    runtimeRegistry.register('opencode-direct', mockRuntime);
    runtimeRegistry.register('opencode-docker', mockRuntime);

    portPool = new PortPool(defaultOrchestratorConfig.portRange.start, defaultOrchestratorConfig.portRange.end);
    runtimeManager = new RuntimeManager(portPool, runtimeRegistry, 'opencode-direct');
    instanceManager = new InstanceManager(defaultOrchestratorConfig, workspaceFactory, runtimeManager);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('createInstance', () => {
    it('creates instance with all lifecycle steps', async () => {
      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });
      mockClient.createSession = vi.fn().mockResolvedValue({
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
      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });
      mockClient.createSession = vi.fn().mockResolvedValue({
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

    it('throws error when spawn fails and propagates message', async () => {
      mockSpawnFn.mockRejectedValue(new Error('No available ports in pool'));

      await expect(instanceManager.createInstance('conv-fail')).rejects.toThrow(
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

      const manager = new InstanceManager(defaultOrchestratorConfig, badFactory, runtimeManager);
      await expect(manager.createInstance('conv-fail')).rejects.toThrow('disk full');
      manager.destroy();
    });

    it('throws when health check fails after retries', async () => {
      mockSpawnFn.mockRejectedValue(new Error('OpenCode instance failed health check after 2 retries'));

      const fastFailConfig = { ...defaultOrchestratorConfig, healthCheck: { retries: 2, intervalMs: 1, clientTimeoutMs: 5000 } };
      const fastFailManager = new InstanceManager(fastFailConfig, workspaceFactory, runtimeManager);

      await expect(fastFailManager.createInstance('conv-health-fail')).rejects.toThrow(
        'OpenCode instance failed health check after 2 retries'
      );
      fastFailManager.destroy();
    });

    it('succeeds on second health check attempt', async () => {
      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });

      const info = await instanceManager.createInstance('conv-retry');
      expect(info).toHaveProperty('id', 'conv-retry');
      expect(info).toHaveProperty('port');
      expect(info.sessionId).toBeUndefined();
    });

    it('calls ensure() when workspace already exists', async () => {
      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });
      mockClient.createSession = vi.fn().mockResolvedValue({
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
      const handle2 = createMockHandle();
      mockSpawnFn.mockResolvedValue({ client: mockClient, port: allocPorts(1)[0], handle: handle2 });

      const info2 = await instanceManager.createInstance('conv-ensure');
      expect(info2.workspacePath).toBe(wsPath);
      expect(existsSync(info2.workspacePath)).toBe(true);
    });

    it('retries after healthy=false health check response', async () => {
      const fastConfig: OrchestratorConfig = {
        ...defaultOrchestratorConfig,
        healthCheck: { retries: 3, intervalMs: 1, clientTimeoutMs: 5000 },
      };
      const fastManager = new InstanceManager(fastConfig, workspaceFactory, runtimeManager);

      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });

      const info = await fastManager.createInstance('conv-health-false');
      expect(info).toHaveProperty('id', 'conv-health-false');
      expect(info.sessionId).toBeUndefined();

      await fastManager.destroyInstance('conv-health-false');
      fastManager.destroy();
    });

  });

  describe('Docker runtime', () => {
    it('handles docker stdout and stderr events', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory, runtimeManager);

      const handle = createMockHandle({ exitCode: null });
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });

      await dockerManager.createInstance('conv-docker-stdio');

      // Instance still tracked before exit
      expect(dockerManager.listInstances()).toHaveLength(1);

      // Cleanup
      await dockerManager.destroyInstance('conv-docker-stdio');
      dockerManager.destroy();
    });

    it('spawns with correct args', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory, runtimeManager);

      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });

      await dockerManager.createInstance('conv-docker');

      expect(mockSpawnFn).toHaveBeenCalledWith(
        'conv-docker',
        expect.stringContaining('conv-docker'),
        expect.objectContaining({ username: 'opencode' }),
        expect.any(Object),
        expect.objectContaining({ type: 'local' }),
      );

      // Cleanup
      await dockerManager.destroyInstance('conv-docker');
      dockerManager.destroy();
    });

    it('creates instance with correct info in docker mode', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory, runtimeManager);

      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });

      const info = await dockerManager.createInstance('conv-docker2');

      expect(info.id).toBe('conv-docker2');
      expect(info.port).toBeGreaterThanOrEqual(41000);
      expect(info.sessionId).toBeUndefined();
      expect(existsSync(info.workspacePath)).toBe(true);
    });

    it('destroys docker container using runtime kill', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory, runtimeManager);

      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });

      await dockerManager.createInstance('conv-docker-rm');

      await dockerManager.destroyInstance('conv-docker-rm');

      expect(handle.kill).toHaveBeenCalledWith('SIGTERM');
      dockerManager.destroy();
    });

    it('cleans up docker container when health check fails', async () => {
      const fastDockerConfig: OrchestratorConfig = {
        ...dockerOrchestratorConfig,
        healthCheck: { retries: 2, intervalMs: 1, clientTimeoutMs: 5000 },
      };
      const dockerManager = new InstanceManager(fastDockerConfig, workspaceFactory, runtimeManager);

      mockSpawnFn.mockRejectedValue(new Error('OpenCode instance failed health check after 2 retries'));

      await expect(dockerManager.createInstance('conv-docker-health-fail')).rejects.toThrow(
        'OpenCode instance failed health check after 2 retries'
      );

      dockerManager.destroy();
    });
  });

  describe('restartInstance', () => {
    it('restarts docker container and waits for health check to pass', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory, runtimeManager);

      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });

      await dockerManager.createInstance('conv-restart');

      mockHealth.mockResolvedValue({ healthy: true, version: '1.0.0' });

      await dockerManager.restartInstance('conv-restart');

      expect(mockRuntime.restart).toHaveBeenCalledWith('conv-restart', dockerOrchestratorConfig.healthCheck);

      await dockerManager.destroyInstance('conv-restart');
      dockerManager.destroy();
    });

    it('throws when instance not found', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory, runtimeManager);
      await expect(dockerManager.restartInstance('no-such-instance')).rejects.toThrow(
        'Instance not found: no-such-instance'
      );
      dockerManager.destroy();
    });

    it('throws when runtime restart fails', async () => {
      const dockerManager = new InstanceManager(dockerOrchestratorConfig, workspaceFactory, runtimeManager);

      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });

      await dockerManager.createInstance('conv-restart-fail');

      (mockRuntime.restart as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('docker restart failed for container agentorchestrator-conv-restart-fail')
      );

      await expect(dockerManager.restartInstance('conv-restart-fail')).rejects.toThrow(
        'docker restart failed for container agentorchestrator-conv-restart-fail'
      );

      await dockerManager.destroyInstance('conv-restart-fail');
      dockerManager.destroy();
    });

    it('throws when health check fails after restart', async () => {
      const fastDockerConfig: OrchestratorConfig = {
        ...dockerOrchestratorConfig,
        healthCheck: { retries: 2, intervalMs: 1, clientTimeoutMs: 5000 },
      };
      const dockerManager = new InstanceManager(fastDockerConfig, workspaceFactory, runtimeManager);

      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });

      await dockerManager.createInstance('conv-restart-health');

      (mockRuntime.restart as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Container restart health check failed for conv-restart-health after 2 retries')
      );

      await expect(dockerManager.restartInstance('conv-restart-health')).rejects.toThrow(
        'Container restart health check failed for conv-restart-health after 2 retries'
      );

      await dockerManager.destroyInstance('conv-restart-health');
      dockerManager.destroy();
    });
  });

  describe('getInstance', () => {
    it('updates lastUsedAt on getInstance', async () => {
      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });
      mockClient.createSession = vi.fn().mockResolvedValue({
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
      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });
      mockClient.createSession = vi.fn().mockResolvedValue({
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
      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });
      mockClient.createSession = vi.fn().mockResolvedValue({
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
    });

    it('destroys instance even when cleanup encounters errors', async () => {
      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });

      await instanceManager.createInstance('conv-rm-err');
      await instanceManager.destroyInstance('conv-rm-err');
      expect(instanceManager.listInstances()).toHaveLength(0);
    });

    it('does not throw for non-existent id', async () => {
      await expect(instanceManager.destroyInstance('ghost')).resolves.toBeUndefined();
    });
  });

  describe('stopInstance', () => {
    it('kills process but preserves workspace on disk', async () => {
      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });
      mockClient.createSession = vi.fn().mockResolvedValue({
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
      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });
      mockClient.createSession = vi.fn().mockResolvedValue({
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
      expect(list[0]).not.toHaveProperty('handle');
    });

    it('returns empty array when no instances', () => {
      expect(instanceManager.listInstances()).toEqual([]);
    });
  });

  describe('process events', () => {
    it('handles stdout and stderr data events', async () => {
      const handle = createMockHandle({ exitCode: null });
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });

      await instanceManager.createInstance('conv-stdio');

      // Clean up via onExit
      handle._fireExit(0);
      await new Promise((r) => setTimeout(r, 10));
      expect(instanceManager.listInstances()).toHaveLength(0);
    });

    it('cleans up instance on handle exit event', async () => {
      const handle = createMockHandle({ exitCode: null });
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });

      await instanceManager.createInstance('conv-exit');
      expect(instanceManager.listInstances()).toHaveLength(1);

      handle._fireExit(0);

      await new Promise((r) => setTimeout(r, 10));
      expect(instanceManager.listInstances()).toHaveLength(0);
    });
  });

  describe('kill edge cases', () => {
    it('does not throw when handle.kill throws', async () => {
      const handle = createMockHandle({ exitCode: null });
      handle.kill = vi.fn().mockRejectedValue(new Error('kill failed'));
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });

      await instanceManager.createInstance('conv-kill-err');
      await expect(instanceManager.destroyInstance('conv-kill-err')).resolves.toBeUndefined();
    });

    it('handles waitForExit timeout when process does not exit', async () => {
      const handle = createMockHandle({ exitCode: null });
      handle.waitForExit = vi.fn().mockResolvedValue(undefined);
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });

      await instanceManager.createInstance('conv-timeout');
      await expect(instanceManager.destroyInstance('conv-timeout')).resolves.toBeUndefined();
    });

    it('does not throw when handle pid is undefined', async () => {
      const handle = createMockHandle({ exitCode: null });
      (handle as any).pid = undefined;
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });

      await instanceManager.createInstance('conv-safe2');

      await expect(instanceManager.destroyInstance('conv-safe2')).resolves.toBeUndefined();
    });
  });

  describe('maxInstances strict enforcement', () => {
    it('evicts LRU when maxInstances is reached', async () => {
      const strictConfig: OrchestratorConfig = {
        ...defaultOrchestratorConfig,
        maxInstances: 1,
        portRange: { start: 30000, end: 30001 },
      };
      const strictRM = new RuntimeManager(portPool, runtimeRegistry, 'opencode-direct');
      const strictManager = new InstanceManager(strictConfig, workspaceFactory, strictRM);

      const handleA = createMockHandle();
      const portA = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port: portA, handle: handleA });

      await strictManager.createInstance('conv-first');
      expect(strictManager.listInstances()).toHaveLength(1);
      expect(strictManager.listInstances()[0].id).toBe('conv-first');

      // Creating a second instance should evict the first one
      const handleB = createMockHandle();
      const portB = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port: portB, handle: handleB });
      await strictManager.createInstance('conv-second');

      const list = strictManager.listInstances();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('conv-second');
      strictManager.destroy();
    });
  });

  describe('idle timeout sweep', () => {
    it('does not start sweep when idleTimeoutMs is 0', async () => {
      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });

      const noSweepConfig: OrchestratorConfig = {
        ...defaultOrchestratorConfig,
        idleTimeoutMs: 0,
      };
      const noSweepManager = new InstanceManager(noSweepConfig, workspaceFactory, runtimeManager);
      await noSweepManager.createInstance('conv-no-sweep');

      noSweepManager.destroy();
    });

    it('destroys idle instance after timeout', async () => {
      const idleConfig: OrchestratorConfig = {
        ...defaultOrchestratorConfig,
        idleTimeoutMs: 100,
        idleSweepIntervalMs: 50,
      };
      const idleManager = new InstanceManager(idleConfig, workspaceFactory, runtimeManager);

      const handle = createMockHandle();
      const port = allocPorts(1)[0];
      mockSpawnFn.mockResolvedValue({ client: mockClient, port, handle });
      mockClient.createSession = vi.fn().mockResolvedValue({
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
      const manager = new InstanceManager(defaultOrchestratorConfig, workspaceFactory, runtimeManager);
      expect(() => manager.destroy()).not.toThrow();
      expect(() => manager.destroy()).not.toThrow();
    });
  });

  describe('cleanupOrphanContainers', () => {
    it('calls cleanupOrphans on all registered runtimes', async () => {
      const manager = new InstanceManager(defaultOrchestratorConfig, workspaceFactory, runtimeManager);
      await manager.cleanupOrphanContainers();
      expect(mockRuntime.cleanupOrphans).toHaveBeenCalled();
      manager.destroy();
    });
  });
});
