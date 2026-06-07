import { describe, it, expect } from 'vitest';
import { loadConfig, validateConfig } from './config-loader.js';
import type { AgentOrchestratorConfig } from './config-loader.js';

function createValidConfig(overrides?: Partial<AgentOrchestratorConfig>): AgentOrchestratorConfig {
  return {
    server: { port: 8080, host: '127.0.0.1', shutdownTimeoutMs: 15000 },
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
  } as AgentOrchestratorConfig;
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

  it('rejects non-positive shutdownTimeoutMs', () => {
    const config = createValidConfig({
      server: { ...createValidConfig().server, shutdownTimeoutMs: 0 },
    });
    expect(() => validateConfig(config)).toThrow('shutdownTimeoutMs must be a positive integer');
  });

  it('rejects negative server.port', () => {
    const config = createValidConfig({
      server: { ...createValidConfig().server, port: -1 },
    });
    expect(() => validateConfig(config)).toThrow('server.port must be a non-negative integer');
  });

  it('rejects non-integer server.port', () => {
    const config = createValidConfig({
      server: { ...createValidConfig().server, port: 1.5 },
    });
    expect(() => validateConfig(config)).toThrow('server.port must be a non-negative integer');
  });

  it('rejects empty server.host', () => {
    const config = createValidConfig({
      server: { ...createValidConfig().server, host: '' },
    });
    expect(() => validateConfig(config)).toThrow('server.host must be a non-empty string');
  });

  it('rejects non-positive websocket.heartbeatIntervalMs', () => {
    const config = createValidConfig({
      websocket: { ...createValidConfig().websocket, heartbeatIntervalMs: 0 },
    });
    expect(() => validateConfig(config)).toThrow('heartbeatIntervalMs must be positive');
  });

  it('rejects non-positive websocket.idleTimeoutMs', () => {
    const config = createValidConfig({
      websocket: { ...createValidConfig().websocket, idleTimeoutMs: 0 },
    });
    expect(() => validateConfig(config)).toThrow('idleTimeoutMs must be positive');
  });

  it('rejects non-positive orchestrator.portRange.start', () => {
    const config = createValidConfig({
      orchestrator: { ...createValidConfig().orchestrator, portRange: { start: 0, end: 100 } },
    });
    expect(() => validateConfig(config)).toThrow('portRange.start must be a positive integer');
  });

  it('rejects non-positive orchestrator.portRange.end', () => {
    const config = createValidConfig({
      orchestrator: { ...createValidConfig().orchestrator, portRange: { start: 100, end: 0 } },
    });
    expect(() => validateConfig(config)).toThrow('portRange.end must be a positive integer');
  });

  it('rejects non-positive healthCheck.retries', () => {
    const config = createValidConfig({
      orchestrator: { ...createValidConfig().orchestrator, healthCheck: { retries: 0, intervalMs: 500 } },
    });
    expect(() => validateConfig(config)).toThrow('healthCheck.retries must be a positive integer');
  });

  it('rejects non-positive healthCheck.intervalMs', () => {
    const config = createValidConfig({
      orchestrator: { ...createValidConfig().orchestrator, healthCheck: { retries: 10, intervalMs: 0 } },
    });
    expect(() => validateConfig(config)).toThrow('healthCheck.intervalMs must be positive');
  });

  it('rejects empty workspace.basePath', () => {
    const config = createValidConfig({
      workspace: { basePath: '', defaultPermissions: {} },
    });
    expect(() => validateConfig(config)).toThrow('workspace.basePath must be a non-empty string');
  });
});

describe('loadConfig with env overrides', () => {
  it('preserves original config when no env override', () => {
    const config = loadConfig();
    expect(config.server.port).toBe(0);
    expect(config.orchestrator.maxInstances).toBe(10);
  });
});
