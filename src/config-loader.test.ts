import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseJSONC } from 'jsonc-parser';
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
      runtime: 'direct',
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

  it('rejects invalid runtime value', () => {
    const config = createValidConfig({
      orchestrator: { ...createValidConfig().orchestrator, runtime: 'invalid' as 'direct' },
    });
    expect(() => validateConfig(config)).toThrow('runtime must be "direct" or "docker"');
  });

  it('requires docker config when runtime is docker', () => {
    const config = createValidConfig({
      orchestrator: { ...createValidConfig().orchestrator, runtime: 'docker', docker: undefined },
    });
    expect(() => validateConfig(config)).toThrow('docker config is required when runtime is "docker"');
  });

  it('accepts valid docker runtime config', () => {
    const config = createValidConfig({
      orchestrator: {
        ...createValidConfig().orchestrator,
        runtime: 'docker',
        docker: { image: 'opencode:latest', containerPort: 3000 },
      },
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('rejects empty docker.image', () => {
    const config = createValidConfig({
      orchestrator: {
        ...createValidConfig().orchestrator,
        runtime: 'docker',
        docker: { image: '', containerPort: 3000 },
      },
    });
    expect(() => validateConfig(config)).toThrow('docker.image must be a non-empty string');
  });

  it('rejects non-positive docker.containerPort', () => {
    const config = createValidConfig({
      orchestrator: {
        ...createValidConfig().orchestrator,
        runtime: 'docker',
        docker: { image: 'opencode:latest', containerPort: 0 },
      },
    });
    expect(() => validateConfig(config)).toThrow('docker.containerPort must be a positive integer');
  });

  it('rejects empty workspace.basePath', () => {
    const config = createValidConfig({
      workspace: { basePath: '', defaultPermissions: {} },
    });
    expect(() => validateConfig(config)).toThrow('workspace.basePath must be a non-empty string');
  });
});

describe('example config file', () => {
  it('parses agentorchestrator.example.json as valid JSONC', () => {
    const examplePath = join(process.cwd(), 'config', 'agentorchestrator.example.json');
    const raw = readFileSync(examplePath, 'utf-8');
    const errors: any[] = [];
    const parsed = parseJSONC(raw, errors) as Record<string, unknown>;
    expect(errors).toHaveLength(0);
    expect(parsed.server).toBeDefined();
    expect(parsed.orchestrator).toBeDefined();
    expect(parsed.workspace).toBeDefined();
  });

  it('validates when parsed as AgentOrchestratorConfig', () => {
    const examplePath = join(process.cwd(), 'config', 'agentorchestrator.example.json');
    const raw = readFileSync(examplePath, 'utf-8');
    const parsed = parseJSONC(raw) as AgentOrchestratorConfig;
    expect(() => validateConfig(parsed)).not.toThrow();
  });
});

describe('loadConfig with env overrides', () => {
  it('preserves original config when no env override', () => {
    const config = loadConfig();
    expect(config.server.port).toBe(0);
    expect(config.orchestrator.maxInstances).toBe(10);
  });
});
