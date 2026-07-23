import { describe, it, expect, vi } from 'vitest';
import { RuntimeInfoProvider } from './runtime-info.js';
import { RuntimeRegistry } from './registry.js';
import { RuntimeManager } from './runtime-manager.js';
import { PortPool } from '../orchestrator/port-pool.js';
import type { AgentOrchestratorConfig } from '../config-loader.js';

function makeConfig(runtimes: Array<{ id: string; type: string; config: Record<string, unknown> }>): AgentOrchestratorConfig {
  return {
    server: { port: 0, host: '127.0.0.1', shutdownTimeoutMs: 15000 },
    websocket: { heartbeatIntervalMs: 30000, idleTimeoutMs: 600000 },
    orchestrator: {
      maxInstances: 10,
      idleTimeoutMs: 600000,
      idleSweepIntervalMs: 60000,
      portRange: { start: 30000, end: 30100 },
      defaultAgentType: 'opencode-direct',
      runtimes: runtimes as any,
      healthCheck: { retries: 10, intervalMs: 500, clientTimeoutMs: 5000 },
      sse: { enabled: true, reconnectMaxAttempts: 10, reconnectBaseMs: 1000, filterHeartbeat: true },
    },
    workspace: { basePath: '/tmp/ws', enforceCanonicalConfig: true, storage: { type: 'local' } },
  };
}

describe('RuntimeInfoProvider', () => {
  it('getRuntimeInfoList returns entries for all configured runtimes', () => {
    const config = makeConfig([
      { id: 'rt1', type: 'direct', config: { binary: 'opencode', version: '1.17.8' } },
      { id: 'rt2', type: 'docker', config: { image: 'opencode:2.0.0' } },
    ]);
    const portPool = new PortPool(40000, 40100, false);
    const registry = new RuntimeRegistry();
    const manager = new RuntimeManager(portPool, registry, 'rt1');

    const provider = new RuntimeInfoProvider(config, registry, manager);
    const list = provider.getRuntimeInfoList();

    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('rt1');
    expect(list[0].type).toBe('direct');
    expect(list[0].version).toBe('1.17.8');
    expect(list[0].registered).toBe(false);
    expect(list[0].instanceCount).toBe(0);

    expect(list[1].id).toBe('rt2');
    expect(list[1].type).toBe('docker');
    expect(list[1].version).toBe('2.0.0');
  });

  it('getRuntimeInfo returns entry for specific id', () => {
    const config = makeConfig([
      { id: 'my-rt', type: 'direct', config: { binary: 'opencode' } },
    ]);
    const portPool = new PortPool(40000, 40100, false);
    const registry = new RuntimeRegistry();
    const manager = new RuntimeManager(portPool, registry, 'my-rt');

    const provider = new RuntimeInfoProvider(config, registry, manager);
    const info = provider.getRuntimeInfo('my-rt');

    expect(info).toBeDefined();
    expect(info!.id).toBe('my-rt');
    expect(info!.type).toBe('direct');
  });

  it('getRuntimeInfo returns undefined for unknown id', () => {
    const config = makeConfig([]);
    const portPool = new PortPool(40000, 40100, false);
    const registry = new RuntimeRegistry();
    const manager = new RuntimeManager(portPool, registry, 'default');

    const provider = new RuntimeInfoProvider(config, registry, manager);
    expect(provider.getRuntimeInfo('unknown')).toBeUndefined();
  });

  it('includes registered status when runtime is in registry', () => {
    const mockRuntime = {
      type: 'test',
      capabilities: { sessions: false, streaming: false, files: false, tools: false, config: false, agents: false, skills: false },
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
    };
    const config = makeConfig([
      { id: 'reg-rt', type: 'direct', config: { binary: 'opencode' } },
    ]);
    const portPool = new PortPool(40000, 40100, false);
    const registry = new RuntimeRegistry();
    registry.register('reg-rt', mockRuntime);
    const manager = new RuntimeManager(portPool, registry, 'reg-rt');

    const provider = new RuntimeInfoProvider(config, registry, manager);
    const info = provider.getRuntimeInfo('reg-rt');

    expect(info!.registered).toBe(true);
  });

  it('returns empty list when no runtimes configured', () => {
    const config = makeConfig([]);
    const portPool = new PortPool(40000, 40100, false);
    const registry = new RuntimeRegistry();
    const manager = new RuntimeManager(portPool, registry, 'default');

    const provider = new RuntimeInfoProvider(config, registry, manager);
    expect(provider.getRuntimeInfoList()).toEqual([]);
  });

  it('includes isValid and error for invalid runtime', () => {
    const config = makeConfig([
      { id: 'bad-rt', type: 'docker', config: {} },
    ]);
    const portPool = new PortPool(40000, 40100, false);
    const registry = new RuntimeRegistry();
    registry.registerInvalid('bad-rt', 'Config validation failed: "image" is required');
    const manager = new RuntimeManager(portPool, registry, 'bad-rt');

    const provider = new RuntimeInfoProvider(config, registry, manager);
    const list = provider.getRuntimeInfoList();

    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('bad-rt');
    expect(list[0].isValid).toBe(false);
    expect(list[0].error).toBe('Config validation failed: "image" is required');
    expect(list[0].capabilities).toBeUndefined();
  });
});
