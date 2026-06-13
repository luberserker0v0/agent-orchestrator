import { readFileSync, existsSync, renameSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseJSONC } from 'jsonc-parser';
import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig, validateConfig, readJSON } from './config-loader.js';
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
    workspace: { basePath: './workspace', enforceCanonicalConfig: true },
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
        portRange: { start: 30000, end: 30100, allowDynamicFallback: false },
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
      workspace: { basePath: '', enforceCanonicalConfig: true },
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

describe('readJSON with JSONC comments', () => {
  it('parses JSON with comments from a non-.example.json path', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'jsonc-test-'));
    const tmpFile = join(tmpDir, 'config.json');
    writeFileSync(tmpFile, '{\n  // comment\n  "key": "value"\n}\n', 'utf-8');
    const result = readJSON(tmpFile);
    expect(result).toEqual({ key: 'value' });
  });
});

describe('loadConfig with env overrides', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('preserves original config when no env override', () => {
    const config = loadConfig();
    expect(config.server.port).toBe(0);
    expect(config.orchestrator.maxInstances).toBe(10);
  });

  it('overrides simple numeric field via env var', () => {
    process.env.AGENTORCHESTRATOR_SERVER_PORT = '9090';
    const config = loadConfig();
    expect(config.server.port).toBe(9090);
  });

  it('preserves string values for non-numeric env vars', () => {
    process.env.AGENTORCHESTRATOR_SERVER_HOST = '0.0.0.0';
    const config = loadConfig();
    expect(config.server.host).toBe('0.0.0.0');
  });

  it('overrides multiple fields via env vars simultaneously', () => {
    process.env.AGENTORCHESTRATOR_SERVER_PORT = '7070';
    process.env.AGENTORCHESTRATOR_SERVER_HOST = '0.0.0.0';
    const config = loadConfig();
    expect(config.server.port).toBe(7070);
    expect(config.server.host).toBe('0.0.0.0');
  });
});

describe('loadConfig fallback paths', () => {
  const CONFIG_DIR = join(process.cwd(), 'config');
  const CONFIG_PATH = join(CONFIG_DIR, 'agentorchestrator.json');
  const EXAMPLE_PATH = join(CONFIG_DIR, 'agentorchestrator.example.json');
  // Hidden backups stay in same directory to avoid cross-device rename errors
  const BAK_JSON = join(CONFIG_DIR, '.agentorchestrator.json.bak');
  const BAK_EXAMPLE = join(CONFIG_DIR, '.agentorchestrator.example.json.bak');

  afterEach(() => {
    if (existsSync(BAK_JSON)) {
      renameSync(BAK_JSON, CONFIG_PATH);
    }
    if (existsSync(BAK_EXAMPLE)) {
      renameSync(BAK_EXAMPLE, EXAMPLE_PATH);
    }
  });

  it('falls back to example.json when agentorchestrator.json is missing', () => {
    if (existsSync(CONFIG_PATH)) {
      renameSync(CONFIG_PATH, BAK_JSON);
    }
    const config = loadConfig();
    expect(config.server).toBeDefined();
    expect(config.orchestrator).toBeDefined();
    expect(config.workspace).toBeDefined();
  });

  it('uses defaults when both config files are missing', () => {
    if (existsSync(CONFIG_PATH)) {
      renameSync(CONFIG_PATH, BAK_JSON);
    }
    if (existsSync(EXAMPLE_PATH)) {
      renameSync(EXAMPLE_PATH, BAK_EXAMPLE);
    }
    const config = loadConfig();
    expect(config.server.port).toBe(0);
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.orchestrator.maxInstances).toBe(10);
    expect(config.workspace.basePath).toBe('./workspace');
  });
});
