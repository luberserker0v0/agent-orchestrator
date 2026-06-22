import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuntimeManager } from './runtime-manager.js';
import { RuntimeRegistry } from './registry.js';
import { PortPool } from '../orchestrator/port-pool.js';
import type { AgentRuntime, AgentClient, InstanceHandle } from './types.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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

describe('RuntimeManager', () => {
  let portPool: PortPool;
  let registry: RuntimeRegistry;
  let runtimeManager: RuntimeManager;
  let mockRuntime: AgentRuntime;
  let mockClient: AgentClient;

  beforeEach(() => {
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

    mockRuntime = {
      type: 'opencode',
      capabilities: { sessions: true, streaming: true, files: true, tools: true, config: true, agents: true, skills: true },
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn(),
      cleanupOrphans: vi.fn().mockResolvedValue(undefined),
    };

    registry = new RuntimeRegistry();
    registry.register('opencode-direct', mockRuntime);

    portPool = new PortPool(40000, 40050);
    runtimeManager = new RuntimeManager(portPool, registry, 'opencode-direct');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── start() ───────────────────────────────────────────────

  describe('start', () => {
    it('creates an instance and registers onExit', async () => {
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 40000, handle });

      const inst = await runtimeManager.start('conv-1', '/workspace/conv-1', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      expect(inst.id).toBe('conv-1');
      expect(inst.port).toBe(40000);
      expect(inst.client).toBe(mockClient);
      expect(inst.handle).toBe(handle);
      expect(handle.onExit).toHaveBeenCalled();
      expect(runtimeManager.has('conv-1')).toBe(true);
      expect(runtimeManager.size).toBe(1);
    });

    it('throws when runtime.start fails', async () => {
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('start failed'));

      await expect(runtimeManager.start('conv-1', '/workspace/conv-1', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 })).rejects.toThrow('start failed');

      expect(runtimeManager.has('conv-1')).toBe(false);
    });

    it('handles missing handle (no onExit registration)', async () => {
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 40001 });

      const inst = await runtimeManager.start('conv-nohandle', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      expect(inst.handle).toBeUndefined();
      expect(runtimeManager.has('conv-nohandle')).toBe(true);
    });
  });

  // ── destroyInstance() ─────────────────────────────────────

  describe('destroyInstance', () => {
    it('kills handle and removes instance', async () => {
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 40010, handle });
      await runtimeManager.start('conv-destroy', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      expect(runtimeManager.has('conv-destroy')).toBe(true);

      await runtimeManager.destroyInstance('conv-destroy');

      expect(runtimeManager.has('conv-destroy')).toBe(false);
      expect(handle.kill).toHaveBeenCalled();
    });

    it('is idempotent for non-existent instance', async () => {
      await expect(runtimeManager.destroyInstance('not-exist')).resolves.toBeUndefined();
    });

    it('does not throw when handle.kill throws', async () => {
      const handle = createMockHandle();
      handle.kill = vi.fn().mockRejectedValue(new Error('kill failed'));
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 40011, handle });
      await runtimeManager.start('conv-killfail', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      await expect(runtimeManager.destroyInstance('conv-killfail')).resolves.toBeUndefined();
      expect(runtimeManager.has('conv-killfail')).toBe(false);
    });
  });

  // ── restartInstance() ─────────────────────────────────────

  describe('restartInstance', () => {
    it('restarts and registers onExit on new handle', async () => {
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 40020, handle });
      await runtimeManager.start('conv-restart', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      const newHandle = createMockHandle();
      (mockRuntime.restart as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 40020, handle: newHandle });

      await runtimeManager.restartInstance('conv-restart', 'opencode-direct');

      expect(mockRuntime.restart).toHaveBeenCalledWith('conv-restart', expect.any(Object));
      expect(runtimeManager.has('conv-restart')).toBe(true);
      expect(newHandle.onExit).toHaveBeenCalled();
    });

    it('throws when instance not found', async () => {
      await expect(runtimeManager.restartInstance('not-exist')).rejects.toThrow('Instance not found: not-exist');
    });

    it('throws when runtime.restart fails', async () => {
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 40022, handle });
      await runtimeManager.start('conv-restartfail', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      (mockRuntime.restart as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('restart exploded'));

      await expect(runtimeManager.restartInstance('conv-restartfail')).rejects.toThrow('restart exploded');
    });

    it('updates port when port changes during restart', async () => {
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 40030, handle });
      await runtimeManager.start('conv-portchange', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      const newHandle = createMockHandle();
      (mockRuntime.restart as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 40031, handle: newHandle });

      await runtimeManager.restartInstance('conv-portchange');

      expect(runtimeManager.getInstance('conv-portchange')?.port).toBe(40031);
    });

    it('process exit on new handle triggers cleanup', async () => {
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 40032, handle });
      await runtimeManager.start('conv-exitrestart', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      const newHandle = createMockHandle();
      (mockRuntime.restart as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 40032, handle: newHandle });

      await runtimeManager.restartInstance('conv-exitrestart');
      expect(runtimeManager.has('conv-exitrestart')).toBe(true);

      newHandle._fireExit(1);
      expect(runtimeManager.has('conv-exitrestart')).toBe(false);
    });

    it('stale onExit from old handle does not destroy new instance or fire onDestroyed', async () => {
      const onDestroyed = vi.fn();
      runtimeManager.setOnDestroyed(onDestroyed);

      const oldHandle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 40033, handle: oldHandle });
      await runtimeManager.start('conv-stale', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });
      expect(runtimeManager.has('conv-stale')).toBe(true);

      // Reset: onDestroyed may have been called during start (it wasn't)
      onDestroyed.mockReset();

      const newHandle = createMockHandle();
      (mockRuntime.restart as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 40033, handle: newHandle });

      await runtimeManager.restartInstance('conv-stale');

      // After restart, the new instance should be in the map
      expect(runtimeManager.has('conv-stale')).toBe(true);

      // Now simulate the stale onExit from the OLD handle firing after restart
      oldHandle._fireExit(0);

      // The old onExit's cleanupInstance should find no instance (deleted before restart)
      // and return early — the new instance must survive
      expect(runtimeManager.has('conv-stale')).toBe(true);
      // onDestroyed should NOT be called by the stale cleanup
      expect(onDestroyed).not.toHaveBeenCalled();
    });
  });

  // ── getInstance() ─────────────────────────────────────────

  describe('getInstance', () => {
    it('returns instance and updates lastUsedAt', async () => {
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 40040, handle });
      await runtimeManager.start('conv-get', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      const before = Date.now();
      const inst = runtimeManager.getInstance('conv-get');
      expect(inst).toBeDefined();
      expect(inst!.id).toBe('conv-get');
      expect(inst!.lastUsedAt).toBeGreaterThanOrEqual(before);
    });

    it('returns undefined for non-existent instance', async () => {
      expect(runtimeManager.getInstance('not-exist')).toBeUndefined();
    });
  });

  // ── has() / size ──────────────────────────────────────────

  describe('has and size', () => {
    it('returns false and 0 for empty manager', () => {
      expect(runtimeManager.has('anything')).toBe(false);
      expect(runtimeManager.size).toBe(0);
    });

    it('returns true and correct count after start', async () => {
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 40050, handle });
      await runtimeManager.start('conv-has', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      expect(runtimeManager.has('conv-has')).toBe(true);
      expect(runtimeManager.size).toBe(1);
    });
  });

  // ── listInstances() ──────────────────────────────────────

  describe('listInstances', () => {
    it('returns empty array when no instances', () => {
      expect(runtimeManager.listInstances()).toEqual([]);
    });

    it('returns subset of instance fields', async () => {
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 41000, handle });
      await runtimeManager.start('conv-list', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      const list = runtimeManager.listInstances();
      expect(list).toHaveLength(1);
      expect(list[0]).toEqual({ id: 'conv-list', port: 41000, lastUsedAt: expect.any(Number) });
      expect(Object.keys(list[0])).toEqual(['id', 'port', 'lastUsedAt']);
    });
  });

  // ── setSessionId() ────────────────────────────────────────

  describe('setSessionId', () => {
    it('sets sessionId on existing instance', async () => {
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 41010, handle });
      await runtimeManager.start('conv-sesh', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      runtimeManager.setSessionId('conv-sesh', 'ses_123');
      expect(runtimeManager.getInstance('conv-sesh')?.sessionId).toBe('ses_123');
    });

    it('does not throw for non-existent instance', () => {
      runtimeManager.setSessionId('not-exist', 'ses_xyz');
    });
  });

  // ── setOnDestroyed() ──────────────────────────────────────

  describe('setOnDestroyed', () => {
    it('fires callback when instance is destroyed via destroyInstance', async () => {
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 41020, handle });
      await runtimeManager.start('conv-cb', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      const cb = vi.fn();
      runtimeManager.setOnDestroyed(cb);

      await runtimeManager.destroyInstance('conv-cb');
      expect(cb).toHaveBeenCalledWith('conv-cb');
    });

    it('does not fire callback for non-existent instance', async () => {
      const cb = vi.fn();
      runtimeManager.setOnDestroyed(cb);

      await runtimeManager.destroyInstance('not-exist');
      expect(cb).not.toHaveBeenCalled();
    });

    it('fires callback when process exits', async () => {
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 41021, handle });
      await runtimeManager.start('conv-cb2', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      const cb = vi.fn();
      runtimeManager.setOnDestroyed(cb);

      handle._fireExit(0);
      await new Promise((r) => setTimeout(r, 10));
      expect(cb).toHaveBeenCalledWith('conv-cb2');
    });
  });

  // ── process exit via onExit ───────────────────────────────

  describe('process exit (onExit)', () => {
    it('cleans up instance when process exits', async () => {
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 41030, handle });
      await runtimeManager.start('conv-exit', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      expect(runtimeManager.has('conv-exit')).toBe(true);

      handle._fireExit(0);
      expect(runtimeManager.has('conv-exit')).toBe(false);
    });
  });

  // ── Queries ───────────────────────────────────────────────

  describe('runtime queries', () => {
    it('hasAgentType returns true for registered type', () => {
      expect(runtimeManager.hasAgentType('opencode-direct')).toBe(true);
      expect(runtimeManager.hasAgentType('unknown')).toBe(false);
    });

    it('getRuntimeValidity returns undefined for unknown type', () => {
      expect(runtimeManager.getRuntimeValidity('unknown')).toBeUndefined();
    });

    it('getRuntimeValidity returns validity for known type', () => {
      const v = runtimeManager.getRuntimeValidity('opencode-direct');
      expect(v).toEqual({ isValid: true });
    });

    it('listAgentTypes returns registered types', () => {
      expect(runtimeManager.listAgentTypes()).toEqual(['opencode-direct']);
    });
  });

  // ── LRU ────────────────────────────────────────────────────

  describe('getLRUCandidateId', () => {
    it('returns undefined when no instances', () => {
      expect(runtimeManager.getLRUCandidateId()).toBeUndefined();
    });

    it('returns the only instance id', async () => {
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 41040, handle });
      await runtimeManager.start('conv-lru', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      expect(runtimeManager.getLRUCandidateId()).toBe('conv-lru');
    });

    it('returns the least recently used instance', async () => {
      const handle1 = createMockHandle();
      const handle2 = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ client: mockClient, port: 41041, handle: handle1 });
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ client: mockClient, port: 41042, handle: handle2 });

      await runtimeManager.start('conv-old', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });
      await runtimeManager.start('conv-new', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      expect(runtimeManager.getLRUCandidateId()).toBe('conv-old');
    });
  });

  // ── Idle ──────────────────────────────────────────────────

  describe('findIdleInstanceIds', () => {
    it('returns empty when idleTimeoutMs is 0', () => {
      expect(runtimeManager.findIdleInstanceIds(0)).toEqual([]);
    });

    it('returns empty when no instances idle', async () => {
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 41050, handle });
      await runtimeManager.start('conv-idle', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      const ids = runtimeManager.findIdleInstanceIds(100000);
      expect(ids).toEqual([]);
    });

    it('returns idle instances after timeout', async () => {
      vi.useFakeTimers();
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 41051, handle });
      await runtimeManager.start('conv-idle2', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      vi.advanceTimersByTime(200);

      const ids = runtimeManager.findIdleInstanceIds(100);
      expect(ids).toContain('conv-idle2');
      vi.useRealTimers();
    });

    it('does not return recently used instances', async () => {
      vi.useFakeTimers();
      const handle = createMockHandle();
      (mockRuntime.start as ReturnType<typeof vi.fn>).mockResolvedValue({ client: mockClient, port: 41052, handle });
      await runtimeManager.start('conv-active', '/workspace', { username: 'u', password: 'p' }, { retries: 1, intervalMs: 100, clientTimeoutMs: 500 });

      runtimeManager.getInstance('conv-active');

      vi.advanceTimersByTime(50);

      const ids = runtimeManager.findIdleInstanceIds(100);
      expect(ids).not.toContain('conv-active');
      vi.useRealTimers();
    });
  });
});
