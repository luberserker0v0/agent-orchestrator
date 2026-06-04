import { describe, it, expect } from 'vitest';
import { loadConfig, validateConfig } from './config-loader.js';
import type { AgentSwitchConfig } from './config-loader.js';

function createValidConfig(overrides?: Partial<AgentSwitchConfig>): AgentSwitchConfig {
  return {
    server: { port: 8080, host: '127.0.0.1' },
    websocket: { heartbeatIntervalMs: 30000, idleTimeoutMs: 600000 },
    orchestrator: {
      maxInstances: 10,
      idleTimeoutMs: 600000,
      idleSweepIntervalMs: 60000,
      portRange: { start: 30000, end: 30100 },
      opencodeBinary: 'opencode',
      healthCheck: { retries: 10, intervalMs: 500 },
    },
    workspace: { basePath: './workspace', defaultPermissions: {} },
    ...overrides,
  } as AgentSwitchConfig;
}

describe('loadConfig', () => {
  it('should load config from file', () => {
    const config = loadConfig();
    expect(config).toHaveProperty('server');
    expect(config).toHaveProperty('websocket');
    expect(config).toHaveProperty('orchestrator');
    expect(config).toHaveProperty('workspace');
  });
});

describe('validateConfig', () => {
  it('accepts valid config', () => {
    expect(() => validateConfig(createValidConfig())).not.toThrow();
  });

  it('rejects maxInstances larger than port range', () => {
    const config = createValidConfig({
      orchestrator: {
        ...createValidConfig().orchestrator,
        maxInstances: 200,
        portRange: { start: 30000, end: 30100 },
      },
    });
    expect(() => validateConfig(config)).toThrow(
      'maxInstances (200) cannot exceed available ports (101)'
    );
  });

  it('rejects non-positive maxInstances', () => {
    const config = createValidConfig({
      orchestrator: { ...createValidConfig().orchestrator, maxInstances: 0 },
    });
    expect(() => validateConfig(config)).toThrow('maxInstances must be a positive integer');
  });

  it('rejects invalid port range', () => {
    const config = createValidConfig({
      orchestrator: { ...createValidConfig().orchestrator, portRange: { start: 30000, end: 30000 } },
    });
    expect(() => validateConfig(config)).toThrow('portRange.end (30000) must be greater than portRange.start (30000)');
  });

  it('rejects negative idleTimeoutMs', () => {
    const config = createValidConfig({
      orchestrator: { ...createValidConfig().orchestrator, idleTimeoutMs: -1 },
    });
    expect(() => validateConfig(config)).toThrow('idleTimeoutMs must be non-negative');
  });

  it('rejects non-positive idleSweepIntervalMs', () => {
    const config = createValidConfig({
      orchestrator: { ...createValidConfig().orchestrator, idleSweepIntervalMs: 0 },
    });
    expect(() => validateConfig(config)).toThrow('idleSweepIntervalMs must be positive');
  });
});
