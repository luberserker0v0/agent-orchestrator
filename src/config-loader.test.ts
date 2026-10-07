import { readFileSync, existsSync, renameSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseJSONC } from 'jsonc-parser';
import { describe, it, expect, afterEach } from 'vitest';
import {
  defaultConfig,
  loadConfig,
  normalizeApiKeys,
  readJSON,
  validateConfig,
  validateDockerIdentityConfig,
  validateDockerLoggingConfig,
  validateSessionStorageConfig,
} from './config-loader.js';
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
      defaultAgentType: 'opencode-direct',
      runtimes: [{ id: 'opencode-direct', type: 'direct', config: { binary: 'opencode' } }],
      healthCheck: { retries: 10, intervalMs: 500, clientTimeoutMs: 5000 },
    },
    workspace: { basePath: './workspace', enforceCanonicalConfig: true, maxSizeBytes: 52428800, storage: { type: 'local' } },
    logging: { file: { enabled: false, directory: './logs', maxFileSizeBytes: 10485760, maxRotatedFiles: 10, retentionMs: 604800000 } },
    cleanup: { ownerId: null, sweepIntervalMs: 3600000, orphanedData: { enabled: false, gracePeriodMs: 2592000000 } },
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

  it('provides the documented cleanup and file logging defaults', () => {
    const config = defaultConfig();

    expect(config.logging.file).toEqual({
      enabled: false,
      directory: './logs',
      maxFileSizeBytes: 10_485_760,
      maxRotatedFiles: 10,
      retentionMs: 604_800_000,
    });
    expect(config.cleanup).toEqual({
      ownerId: null,
      sweepIntervalMs: 3_600_000,
      orphanedData: {
        enabled: false,
        gracePeriodMs: 2_592_000_000,
      },
    });
  });

  it('deep-merges partial cleanup and file logging objects with defaults', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ao-config-merge-'));
    const path = join(directory, 'agentorchestrator.json');
    writeFileSync(path, JSON.stringify({
      logging: { file: { enabled: true, maxRotatedFiles: 4 } },
      cleanup: {
        ownerId: 'deep-merge-owner',
        orphanedData: { enabled: true },
      },
    }), 'utf8');

    try {
      const config = loadConfig(path);

      expect(config.logging.file).toEqual({
        enabled: true,
        directory: './logs',
        maxFileSizeBytes: 10_485_760,
        maxRotatedFiles: 4,
        retentionMs: 604_800_000,
      });
      expect(config.cleanup).toEqual({
        ownerId: 'deep-merge-owner',
        sweepIntervalMs: 3_600_000,
        orphanedData: {
          enabled: true,
          gracePeriodMs: 2_592_000_000,
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('validateConfig', () => {
  it('accepts valid config', () => {
    expect(() => validateConfig(createValidConfig())).not.toThrow();
  });

  it('rejects deprecated runtime field', () => {
    const config = createValidConfig();
    (config.orchestrator as any).runtime = 'docker';
    expect(() => validateConfig(config)).toThrow(
      'orchestrator.runtime is deprecated'
    );
  });

  it('rejects deprecated runtimeConfig field', () => {
    const config = createValidConfig();
    (config.orchestrator as any).runtimeConfig = { binary: 'opencode' };
    expect(() => validateConfig(config)).toThrow(
      'orchestrator.runtimeConfig is deprecated'
    );
  });

  it('rejects deprecated agentType field', () => {
    const config = createValidConfig();
    (config.orchestrator as any).agentType = 'opencode';
    expect(() => validateConfig(config)).toThrow(
      'orchestrator.agentType is deprecated'
    );
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

  it('rejects apiKey shorter than 8 characters', () => {
    const config = createValidConfig({
      server: { ...createValidConfig().server, apiKey: 'short' },
    });
    expect(() => validateConfig(config)).toThrow('server.apiKey must be a string of at least 8 characters');
  });

  it('accepts valid apiKey', () => {
    const config = createValidConfig({
      server: { ...createValidConfig().server, apiKey: 'valid-api-key-123' },
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  // ─── apiKeys validation ─────────────────────────────

  it('accepts valid apiKeys array', () => {
    const config = createValidConfig({
      server: {
        ...createValidConfig().server,
        apiKeys: [
          { key: 'admin-key-123456', role: 'admin' },
          { key: 'obs-key-1234567', role: 'observer', name: 'Observer' },
        ],
      },
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('rejects apiKeys that is not an array', () => {
    const config = createValidConfig({
      server: { ...createValidConfig().server, apiKeys: 'not-an-array' as any },
    });
    expect(() => validateConfig(config)).toThrow('server.apiKeys must be an array');
  });

  it('rejects apiKeys entry with short key', () => {
    const config = createValidConfig({
      server: {
        ...createValidConfig().server,
        apiKeys: [{ key: 'short', role: 'admin' }],
      },
    });
    expect(() => validateConfig(config)).toThrow('at least 8 characters');
  });

  it('rejects apiKeys entry with invalid role', () => {
    const config = createValidConfig({
      server: {
        ...createValidConfig().server,
        apiKeys: [{ key: 'valid-key-1234', role: 'superuser' as any }],
      },
    });
    expect(() => validateConfig(config)).toThrow('references unknown role "superuser"');
  });

  it('accepts an API key assigned to a configured custom role', () => {
    const config = createValidConfig({
      roles: { deployer: { permissions: ['conversation:start'] } },
      server: {
        ...createValidConfig().server,
        apiKeys: [{ key: 'custom-role-key', role: 'deployer' }],
      },
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('rejects duplicate apiKeys', () => {
    const config = createValidConfig({
      server: {
        ...createValidConfig().server,
        apiKeys: [
          { key: 'same-key-12345', role: 'admin' },
          { key: 'same-key-12345', role: 'observer' },
        ],
      },
    });
    expect(() => validateConfig(config)).toThrow('duplicate apiKey');
  });

  it('accepts empty apiKeys array', () => {
    const config = createValidConfig({
      server: { ...createValidConfig().server, apiKeys: [] },
    });
    expect(() => validateConfig(config)).not.toThrow();
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
      orchestrator: { ...createValidConfig().orchestrator, healthCheck: { retries: 0, intervalMs: 500, clientTimeoutMs: 5000 } },
    });
    expect(() => validateConfig(config)).toThrow('healthCheck.retries must be a positive integer');
  });

  it('rejects non-positive healthCheck.intervalMs', () => {
    const config = createValidConfig({
      orchestrator: { ...createValidConfig().orchestrator, healthCheck: { retries: 10, intervalMs: 0, clientTimeoutMs: 5000 } },
    });
    expect(() => validateConfig(config)).toThrow('healthCheck.intervalMs must be positive');
  });

  it('accepts docker runtime entry', () => {
    const config = createValidConfig({
      orchestrator: {
        ...createValidConfig().orchestrator,
        defaultAgentType: 'opencode-docker',
        runtimes: [{ id: 'opencode-docker', type: 'docker', config: { image: 'opencode:latest' } }],
      },
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('rejects empty workspace.basePath', () => {
    const config = createValidConfig({
      workspace: { basePath: '', enforceCanonicalConfig: true, storage: { type: 'local' } },
    });
    expect(() => validateConfig(config)).toThrow('workspace.basePath must be a non-empty string');
  });

  it('accepts workspace.maxSizeBytes of 0 as unlimited', () => {
    const config = createValidConfig({
      workspace: { basePath: './ws', enforceCanonicalConfig: true, maxSizeBytes: 0, storage: { type: 'local' } },
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('rejects negative workspace.maxSizeBytes', () => {
    const config = createValidConfig({
      workspace: { basePath: './ws', enforceCanonicalConfig: true, maxSizeBytes: -1, storage: { type: 'local' } },
    });
    expect(() => validateConfig(config)).toThrow('workspace.maxSizeBytes must be a non-negative integer');
  });

  // ── Runtime entry validation ──

  it('rejects empty runtimes array', () => {
    const config = createValidConfig({
      orchestrator: { ...createValidConfig().orchestrator, runtimes: [] },
    });
    expect(() => validateConfig(config)).toThrow('runtimes must be a non-empty array');
  });

  it('rejects defaultAgentType not found in runtimes', () => {
    const config = createValidConfig({
      orchestrator: {
        ...createValidConfig().orchestrator,
        defaultAgentType: 'nonexistent',
      },
    });
    expect(() => validateConfig(config)).toThrow('defaultAgentType "nonexistent" not found in runtimes array');
  });

  it('rejects empty defaultAgentType', () => {
    const config = createValidConfig({
      orchestrator: { ...createValidConfig().orchestrator, defaultAgentType: '' },
    });
    expect(() => validateConfig(config)).toThrow('defaultAgentType must be a non-empty string');
  });

  it('rejects runtime entry without id', () => {
    const config = createValidConfig({
      orchestrator: {
        ...createValidConfig().orchestrator,
        runtimes: [{ id: '', type: 'direct', config: { binary: 'opencode' } }] as any,
      },
    });
    expect(() => validateConfig(config)).toThrow('must have a non-empty string "id"');
  });

  it('rejects duplicate runtime ids', () => {
    const config = createValidConfig({
      orchestrator: {
        ...createValidConfig().orchestrator,
        runtimes: [
          { id: 'dup', type: 'direct', config: { binary: 'opencode' } },
          { id: 'dup', type: 'direct', config: { binary: 'opencode' } },
        ],
      },
    });
    expect(() => validateConfig(config)).toThrow('duplicate runtime id "dup"');
  });

  it('rejects runtime entry with empty type', () => {
    const config = createValidConfig({
      orchestrator: {
        ...createValidConfig().orchestrator,
        runtimes: [{ id: 'bad', type: '', config: { binary: 'opencode' } }] as any,
      },
    });
    expect(() => validateConfig(config)).toThrow('must have a non-empty string "type"');
  });

  it('accepts docker entry with networkMode', () => {
    const config = createValidConfig({
      orchestrator: {
        ...createValidConfig().orchestrator,
        defaultAgentType: 'd',
        runtimes: [{ id: 'd', type: 'docker', config: { image: 'img', networkMode: 'host' } }],
      },
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('accepts multiple runtimes simultaneously', () => {
    const config = createValidConfig({
      orchestrator: {
        ...createValidConfig().orchestrator,
        defaultAgentType: 'direct-rt',
        runtimes: [
          { id: 'direct-rt', type: 'direct', config: { binary: 'opencode' } },
          { id: 'docker-rt', type: 'docker', config: { image: 'img' } },
        ],
      },
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  describe('validateSessionStorageConfig', () => {
    it('accepts undefined (feature disabled)', () => {
      expect(validateSessionStorageConfig(undefined)).toEqual([]);
    });

    it('accepts sharedRoot with default xdg mode', () => {
      expect(validateSessionStorageConfig({ sharedRoot: '/data/sessions' })).toEqual([]);
    });

    it('accepts explicit sqlite mode', () => {
      expect(validateSessionStorageConfig({ sharedRoot: '/data/sessions', mode: 'sqlite' })).toEqual([]);
    });

    it('rejects non-object values', () => {
      expect(validateSessionStorageConfig('nope')).toEqual(['"sessionStorage" must be an object']);
    });

    it('rejects missing or empty sharedRoot', () => {
      expect(validateSessionStorageConfig({})).toEqual(['"sessionStorage.sharedRoot" must be a non-empty string']);
      expect(validateSessionStorageConfig({ sharedRoot: '' })).toEqual(['"sessionStorage.sharedRoot" must be a non-empty string']);
    });

    it('rejects unknown mode', () => {
      expect(validateSessionStorageConfig({ sharedRoot: '/x', mode: 'nfs' })).toEqual([
        '"sessionStorage.mode" must be "xdg" or "sqlite"',
      ]);
    });
  });

  describe('cleanup and file logging validation', () => {
    it('accepts disabled conservative defaults', () => {
      expect(() => validateConfig(createValidConfig())).not.toThrow();
    });

    it('requires an owner when orphan cleanup is enabled', () => {
      const config = createValidConfig();
      config.cleanup.orphanedData.enabled = true;
      expect(() => validateConfig(config)).toThrow('cleanup.ownerId is required');
    });

    it('rejects a whitespace-only owner when orphan cleanup is enabled', () => {
      const config = createValidConfig();
      config.cleanup.ownerId = '   ';
      config.cleanup.orphanedData.enabled = true;
      expect(() => validateConfig(config)).toThrow('cleanup.ownerId');
    });

    it('accepts enabled cleanup with a stable owner', () => {
      const config = createValidConfig();
      config.cleanup.ownerId = 'primary-ao';
      config.cleanup.orphanedData.enabled = true;
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('rejects filesystem-root log directories and invalid numeric limits', () => {
      const rootConfig = createValidConfig();
      rootConfig.logging.file.directory = process.platform === 'win32' ? 'C:\\' : '/';
      expect(() => validateConfig(rootConfig)).toThrow('cannot be a filesystem root');

      const sizeConfig = createValidConfig();
      sizeConfig.logging.file.maxFileSizeBytes = 0;
      expect(() => validateConfig(sizeConfig)).toThrow('maxFileSizeBytes must be a positive safe integer');
    });
  });

  describe('validateDockerLoggingConfig', () => {
    it('accepts bounded local logging', () => {
      expect(validateDockerLoggingConfig({ driver: 'local', maxSize: '10m', maxFiles: 3 })).toEqual([]);
    });

    it('rejects unsafe driver and limits', () => {
      expect(validateDockerLoggingConfig({ driver: 'syslog', maxSize: 'all', maxFiles: 0 })).toEqual([
        '"logging.driver" must be "local" or "json-file"',
        '"logging.maxSize" must be a Docker size such as "10m"',
        '"logging.maxFiles" must be a positive integer',
      ]);
    });
  });

  describe('validateDockerIdentityConfig', () => {
    it('accepts named and numeric Docker identities', () => {
      expect(validateDockerIdentityConfig({ containerUser: 'opencode' })).toEqual([]);
      expect(validateDockerIdentityConfig({
        containerUser: '1000:1000',
        containerHome: '/tmp/agentorchestrator-home',
      })).toEqual([]);
    });

    it('rejects malformed identities and relative home paths', () => {
      expect(validateDockerIdentityConfig({
        containerUser: '1000:1000:1000',
        containerHome: 'tmp/home',
      })).toEqual([
        '"containerUser" must be a Docker user or uid[:gid]',
        '"containerHome" must be an absolute container path',
      ]);
    });
  });

  describe('cluster validation', () => {
    it('accepts absent cluster section (reporting disabled)', () => {
      const config = createValidConfig();
      delete config.cluster;
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('accepts valid cluster config', () => {
      const config = createValidConfig({
        cluster: { enabled: true, namespace: 'ao-instances', heartbeatIntervalMs: 30000, quotaFailureThreshold: 3 },
      });
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('rejects non-boolean enabled', () => {
      const config = createValidConfig({ cluster: { enabled: 'yes' } as unknown as { enabled: boolean } });
      expect(() => validateConfig(config)).toThrow('cluster.enabled must be a boolean');
    });

    it('rejects empty namespace', () => {
      const config = createValidConfig({ cluster: { namespace: '' } });
      expect(() => validateConfig(config)).toThrow('cluster.namespace must be a non-empty string');
    });

    it('rejects negative heartbeat interval', () => {
      const config = createValidConfig({ cluster: { heartbeatIntervalMs: -1 } });
      expect(() => validateConfig(config)).toThrow('cluster.heartbeatIntervalMs must be a non-negative integer');
    });

    it('rejects zero quota failure threshold', () => {
      const config = createValidConfig({ cluster: { quotaFailureThreshold: 0 } });
      expect(() => validateConfig(config)).toThrow('cluster.quotaFailureThreshold must be a positive integer');
    });

    it('rejects empty advertiseBaseUrl', () => {
      const config = createValidConfig({ cluster: { advertiseBaseUrl: '' } });
      expect(() => validateConfig(config)).toThrow('cluster.advertiseBaseUrl must be a non-empty string');
    });
  });

  // ─── RBAC validation ─────────────────────────────────────

  it('accepts rbac.enabled: true with apiKeys', () => {
    const config = createValidConfig({
      server: {
        port: 8080, host: '127.0.0.1', shutdownTimeoutMs: 15000,
        apiKeys: [{ key: 'admin-secret-123456', role: 'admin' }],
        rbac: { enabled: true },
      },
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('accepts rbac.enabled: true with legacy apiKey', () => {
    const config = createValidConfig({
      server: {
        port: 8080, host: '127.0.0.1', shutdownTimeoutMs: 15000,
        apiKey: 'legacy-key-123456',
        rbac: { enabled: true },
      },
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('rejects rbac.enabled: true without any API keys', () => {
    const config = createValidConfig({
      server: { port: 8080, host: '127.0.0.1', shutdownTimeoutMs: 15000, rbac: { enabled: true } },
    });
    expect(() => validateConfig(config)).toThrow('server.rbac.enabled is true but no API keys configured');
  });

  it('rejects placeholder API keys', () => {
    const config = createValidConfig({
      server: {
        port: 8080,
        host: '127.0.0.1',
        shutdownTimeoutMs: 15000,
        apiKeys: [{ key: 'CHANGEME-admin-secret', role: 'admin' }],
      },
    });
    expect(() => validateConfig(config)).toThrow('replace placeholder API keys');
  });

  it('accepts rbac.enabled: false without API keys', () => {
    const config = createValidConfig({
      server: { port: 8080, host: '127.0.0.1', shutdownTimeoutMs: 15000, rbac: { enabled: false } },
    });
    expect(() => validateConfig(config)).not.toThrow();
  });

  it('rejects non-boolean rbac.enabled', () => {
    const config = createValidConfig({
      server: { port: 8080, host: '127.0.0.1', shutdownTimeoutMs: 15000, rbac: { enabled: 'yes' as any } },
    });
    expect(() => validateConfig(config)).toThrow('server.rbac.enabled must be a boolean');
  });

  it('rejects non-object rbac', () => {
    const config = createValidConfig({
      server: { port: 8080, host: '127.0.0.1', shutdownTimeoutMs: 15000, rbac: 'invalid' as any },
    });
    expect(() => validateConfig(config)).toThrow('server.rbac must be an object');
  });

  it('accepts config without rbac field (backward compatible)', () => {
    const config = createValidConfig({
      server: { port: 8080, host: '127.0.0.1', shutdownTimeoutMs: 15000 },
    });
    expect(() => validateConfig(config)).not.toThrow();
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

  it('overrides workspace.maxSizeBytes via env var', () => {
    process.env.AGENTORCHESTRATOR_WORKSPACE_MAXSIZEBYTES = '104857600';
    const config = loadConfig();
    expect(config.workspace.maxSizeBytes).toBe(104857600);
  });

  it('allows maxSizeBytes=0 via env var for unlimited', () => {
    process.env.AGENTORCHESTRATOR_WORKSPACE_MAXSIZEBYTES = '0';
    const config = loadConfig();
    expect(config.workspace.maxSizeBytes).toBe(0);
  });

  it('maps underscore-separated names onto camelCase config keys', () => {
    process.env.AGENTORCHESTRATOR_SERVER_SHUTDOWN_TIMEOUT_MS = '22222';
    process.env.AGENTORCHESTRATOR_ORCHESTRATOR_IDLE_SWEEP_INTERVAL_MS = '12345';
    const config = loadConfig();
    expect(config.server.shutdownTimeoutMs).toBe(22222);
    expect(config.orchestrator.idleSweepIntervalMs).toBe(12345);
  });

  it('overrides nested cleanup and file logging settings', () => {
    process.env.AGENTORCHESTRATOR_LOGGING_FILE_ENABLED = 'true';
    process.env.AGENTORCHESTRATOR_LOGGING_FILE_MAX_FILE_SIZE_BYTES = '2048';
    process.env.AGENTORCHESTRATOR_CLEANUP_OWNER_ID = 'env-owner';
    process.env.AGENTORCHESTRATOR_CLEANUP_SWEEP_INTERVAL_MS = '6000';
    process.env.AGENTORCHESTRATOR_CLEANUP_ORPHANED_DATA_ENABLED = 'true';
    process.env.AGENTORCHESTRATOR_CLEANUP_ORPHANED_DATA_GRACE_PERIOD_MS = '5000';
    const config = loadConfig();
    expect(config.logging.file.enabled).toBe(true);
    expect(config.logging.file.maxFileSizeBytes).toBe(2048);
    expect(config.cleanup.ownerId).toBe('env-owner');
    expect(config.cleanup.sweepIntervalMs).toBe(6000);
    expect(config.cleanup.orphanedData).toEqual({ enabled: true, gracePeriodMs: 5000 });
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

describe('normalizeApiKeys', () => {
  it('returns apiKeys when apiKeys is set', () => {
    const serverConfig = {
      port: 8080,
      host: '127.0.0.1',
      shutdownTimeoutMs: 15000,
      apiKeys: [
        { key: 'admin-key-123456', role: 'admin' as const },
        { key: 'obs-key-12345678', role: 'observer' as const },
      ],
    };
    const result = normalizeApiKeys(serverConfig);
    expect(result).toHaveLength(2);
    expect(result![0].role).toBe('admin');
    expect(result![1].role).toBe('observer');
  });

  it('converts legacy apiKey to admin apiKeys entry', () => {
    const serverConfig = { port: 8080, host: '127.0.0.1', shutdownTimeoutMs: 15000, apiKey: 'legacy-key-12345' };
    const result = normalizeApiKeys(serverConfig);
    expect(result).toHaveLength(1);
    expect(result![0].key).toBe('legacy-key-12345');
    expect(result![0].role).toBe('admin');
  });

  it('returns undefined when no auth is configured', () => {
    const serverConfig = { port: 8080, host: '127.0.0.1', shutdownTimeoutMs: 15000 };
    const result = normalizeApiKeys(serverConfig);
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty apiKey', () => {
    const serverConfig = { port: 8080, host: '127.0.0.1', shutdownTimeoutMs: 15000, apiKey: '' };
    const result = normalizeApiKeys(serverConfig);
    expect(result).toBeUndefined();
  });

  it('apiKeys takes precedence over apiKey', () => {
    const serverConfig = {
      port: 8080,
      host: '127.0.0.1',
      shutdownTimeoutMs: 15000,
      apiKey: 'legacy-key-12345',
      apiKeys: [{ key: 'new-key-1234567', role: 'observer' as const }],
    };
    const result = normalizeApiKeys(serverConfig);
    expect(result).toHaveLength(1);
    expect(result![0].key).toBe('new-key-1234567');
    expect(result![0].role).toBe('observer');
  });
});
