import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseJSONC } from 'jsonc-parser';

export type ApiKeyRole = 'admin' | 'observer';

export interface ApiKeyEntry {
  key: string;
  role: ApiKeyRole;
  name?: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  shutdownTimeoutMs: number;
  /** @deprecated Use apiKeys instead. If set alone, treated as admin role. */
  apiKey?: string;
  apiKeys?: ApiKeyEntry[];
}

export interface WebSocketConfig {
  heartbeatIntervalMs: number;
  idleTimeoutMs: number;
}

export interface HealthCheckConfig {
  retries: number;
  intervalMs: number;
  /** Timeout per health-check HTTP request in ms (default: 5000) */
  clientTimeoutMs: number;
}

export interface DirectRuntimeConfig {
  /** Path or name of the `opencode` binary (default: `opencode`) */
  binary: string;
  /** Version of the opencode binary (used by the version registry) */
  version?: string;
  /** Hostname used to reach the spawned instance (default: `127.0.0.1`) */
  instanceHost?: string;
}

export interface DockerRuntimeConfig {
  /** Docker image to pull and run (e.g. `ghcr.io/anomalyco/opencode:1.17.8`) */
  image: string;
  /** Hostname used to reach the spawned instance (default: `127.0.0.1`) */
  instanceHost?: string;
  /** Docker network mode (e.g. `host`, `bridge`, or a custom network name). When `host`, port mapping is skipped. */
  networkMode?: string;
}

export interface DirectRuntimeEntry {
  id: string;
  type: 'direct';
  config: DirectRuntimeConfig;
}

export interface DockerRuntimeEntry {
  id: string;
  type: 'docker';
  config: DockerRuntimeConfig;
}

export type RuntimeEntry = DirectRuntimeEntry | DockerRuntimeEntry;

export interface SSEConfig {
  /** Enable SSE event forwarding from OpenCode instances */
  enabled: boolean;
  /** Max reconnect attempts before giving up (default: 10) */
  reconnectMaxAttempts: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  reconnectBaseMs: number;
  /** Filter heartbeat events to reduce noise (default: true) */
  filterHeartbeat: boolean;
}

export interface OrchestratorConfig {
  maxInstances: number;
  idleTimeoutMs: number;
  idleSweepIntervalMs: number;
  portRange: {
    start: number;
    end: number;
    /** When true (default), PortPool falls back to OS-assigned port when the configured range is exhausted */
    allowDynamicFallback?: boolean;
  };
  defaultAgentType: string;
  runtimes: RuntimeEntry[];
  healthCheck: HealthCheckConfig;
  sse: SSEConfig;
}

export interface StorageConfig {
  type: 'local';
}

export interface WorkspaceConfig {
  basePath: string;
  enforceCanonicalConfig: boolean;
  maxSizeBytes?: number;
  storage: StorageConfig;
}

export interface AgentOrchestratorConfig {
  server: ServerConfig;
  websocket: WebSocketConfig;
  orchestrator: OrchestratorConfig;
  workspace: WorkspaceConfig;
}

const CONFIG_DIR = join(process.cwd(), 'config');
const CONFIG_PATH = join(CONFIG_DIR, 'agentorchestrator.json');
const EXAMPLE_PATH = join(CONFIG_DIR, 'agentorchestrator.example.json');
const CANONICAL_OPECONFIG_PATH = join(CONFIG_DIR, 'canonical-opencode.json');
const CANONICAL_OPECONFIG_EXAMPLE_PATH = join(CONFIG_DIR, 'canonical-opencode.example.json');

function applyEnvOverrides(config: Record<string, unknown>, prefix = 'AGENTORCHESTRATOR'): void {
  for (const [envKey, envValue] of Object.entries(process.env)) {
    if (!envKey.startsWith(prefix + '_')) continue;

    const path = envKey
      .slice(prefix.length + 1)
      .split('_')
      .map((part, index) =>
        index === 0 ? part.toLowerCase() : part[0].toLowerCase() + part.slice(1).toLowerCase()
      );

    let current: Record<string, unknown> = config;
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i];
      const matchedKey = Object.keys(current).find(
        k => k.toLowerCase() === key.toLowerCase()
      ) ?? key;
      if (!current[matchedKey] || typeof current[matchedKey] !== 'object') {
        current[matchedKey] = {};
      }
      current = current[matchedKey] as Record<string, unknown>;
    }

    const leafKey = path[path.length - 1];
    const matchedKey = Object.keys(current).find(
      k => k.toLowerCase() === leafKey.toLowerCase()
    );
    const finalKey = matchedKey ?? leafKey;
    const trimmed = envValue?.trim() ?? '';
    const numValue = Number(trimmed);
    const isValidNumber =
      trimmed !== '' &&
      Number.isFinite(numValue) &&
      !Number.isNaN(numValue);
    current[finalKey] = isValidNumber ? numValue : envValue;
  }
}

export function validateConfig(config: AgentOrchestratorConfig): void {
  const { orchestrator, server, websocket } = config;

  // Server validation
  if (typeof server.port !== 'number' || server.port < 0 || !Number.isInteger(server.port)) {
    throw new Error(`Config validation failed: server.port must be a non-negative integer, got ${server.port}`);
  }
  if (!server.host || typeof server.host !== 'string') {
    throw new Error('Config validation failed: server.host must be a non-empty string');
  }
  if (typeof server.shutdownTimeoutMs !== 'number' || !Number.isInteger(server.shutdownTimeoutMs) || server.shutdownTimeoutMs <= 0) {
    throw new Error(`Config validation failed: server.shutdownTimeoutMs must be a positive integer, got ${server.shutdownTimeoutMs}`);
  }
  if (server.apiKey !== undefined && server.apiKey !== '' && (typeof server.apiKey !== 'string' || server.apiKey.length < 8)) {
    throw new Error(`Config validation failed: server.apiKey must be a string of at least 8 characters, got ${typeof server.apiKey === 'string' ? 'too short' : typeof server.apiKey}`);
  }
  if (server.apiKeys !== undefined) {
    if (!Array.isArray(server.apiKeys)) {
      throw new Error('Config validation failed: server.apiKeys must be an array');
    }
    const keys = new Set<string>();
    for (const entry of server.apiKeys) {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error('Config validation failed: each entry in server.apiKeys must be an object');
      }
      if (typeof entry.key !== 'string' || entry.key.length < 8) {
        throw new Error('Config validation failed: each apiKeys entry must have a "key" string of at least 8 characters');
      }
      if (entry.role !== 'admin' && entry.role !== 'observer') {
        throw new Error(`Config validation failed: apiKeys entry role must be "admin" or "observer", got "${entry.role}"`);
      }
      if (keys.has(entry.key)) {
        throw new Error(`Config validation failed: duplicate apiKey "${entry.key.slice(0, 4)}..."`);
      }
      keys.add(entry.key);
    }
  }

  // WebSocket validation
  if (typeof websocket.heartbeatIntervalMs !== 'number' || websocket.heartbeatIntervalMs <= 0) {
    throw new Error(`Config validation failed: websocket.heartbeatIntervalMs must be positive, got ${websocket.heartbeatIntervalMs}`);
  }
  if (typeof websocket.idleTimeoutMs !== 'number' || websocket.idleTimeoutMs <= 0) {
    throw new Error(`Config validation failed: websocket.idleTimeoutMs must be positive, got ${websocket.idleTimeoutMs}`);
  }

  // Check for deprecated orchestrator fields
  const orchestratorRaw = orchestrator as unknown as Record<string, unknown>;
  if ('runtime' in orchestratorRaw) {
    throw new Error(
      'Config validation failed: orchestrator.runtime is deprecated. ' +
      'Use orchestrator.runtimes (array) instead. See config/agentorchestrator.example.json.'
    );
  }
  if ('runtimeConfig' in orchestratorRaw) {
    throw new Error(
      'Config validation failed: orchestrator.runtimeConfig is deprecated. ' +
      'Move each runtime config into orchestrator.runtimes[].config. See config/agentorchestrator.example.json.'
    );
  }
  if ('agentType' in orchestratorRaw) {
    throw new Error(
      'Config validation failed: orchestrator.agentType is deprecated. ' +
      'Use orchestrator.defaultAgentType instead. See config/agentorchestrator.example.json.'
    );
  }

  // Orchestrator validation
  if (typeof orchestrator.maxInstances !== 'number' || !Number.isInteger(orchestrator.maxInstances) || orchestrator.maxInstances <= 0) {
    throw new Error(`Config validation failed: orchestrator.maxInstances must be a positive integer, got ${orchestrator.maxInstances}`);
  }
  if (typeof orchestrator.idleTimeoutMs !== 'number' || orchestrator.idleTimeoutMs < 0) {
    throw new Error(`Config validation failed: orchestrator.idleTimeoutMs must be non-negative, got ${orchestrator.idleTimeoutMs}`);
  }
  if (typeof orchestrator.idleSweepIntervalMs !== 'number' || orchestrator.idleSweepIntervalMs <= 0) {
    throw new Error(`Config validation failed: orchestrator.idleSweepIntervalMs must be positive, got ${orchestrator.idleSweepIntervalMs}`);
  }
  if (typeof orchestrator.portRange.start !== 'number' || !Number.isInteger(orchestrator.portRange.start) || orchestrator.portRange.start <= 0) {
    throw new Error(`Config validation failed: orchestrator.portRange.start must be a positive integer, got ${orchestrator.portRange.start}`);
  }
  if (typeof orchestrator.portRange.end !== 'number' || !Number.isInteger(orchestrator.portRange.end) || orchestrator.portRange.end <= 0) {
    throw new Error(`Config validation failed: orchestrator.portRange.end must be a positive integer, got ${orchestrator.portRange.end}`);
  }
  if (orchestrator.portRange.end <= orchestrator.portRange.start) {
    throw new Error(`Config validation failed: portRange.end (${orchestrator.portRange.end}) must be greater than portRange.start (${orchestrator.portRange.start})`);
  }
  if (orchestrator.portRange.allowDynamicFallback !== undefined && typeof orchestrator.portRange.allowDynamicFallback !== 'boolean') {
    throw new Error(`Config validation failed: orchestrator.portRange.allowDynamicFallback must be a boolean, got ${orchestrator.portRange.allowDynamicFallback}`);
  }
  const dynamicFallback = orchestrator.portRange.allowDynamicFallback ?? true;
  if (!dynamicFallback) {
    const portCount = orchestrator.portRange.end - orchestrator.portRange.start + 1;
    if (orchestrator.maxInstances > portCount) {
      throw new Error(
        `Config validation failed: maxInstances (${orchestrator.maxInstances}) cannot exceed available ports (${portCount}). ` +
        `Either increase portRange, decrease maxInstances, or enable allowDynamicFallback.`
      );
    }
  }

  // Runtime entries validation
  if (!Array.isArray(orchestrator.runtimes) || orchestrator.runtimes.length === 0) {
    throw new Error('Config validation failed: orchestrator.runtimes must be a non-empty array');
  }
  if (typeof orchestrator.defaultAgentType !== 'string' || !orchestrator.defaultAgentType) {
    throw new Error(`Config validation failed: orchestrator.defaultAgentType must be a non-empty string, got ${orchestrator.defaultAgentType}`);
  }
  const runtimeIds = new Set<string>();
  let defaultFound = false;
  for (const entry of orchestrator.runtimes) {
    if (typeof entry.id !== 'string' || !entry.id) {
      throw new Error('Config validation failed: each runtime entry must have a non-empty string "id"');
    }
    if (runtimeIds.has(entry.id)) {
      throw new Error(`Config validation failed: duplicate runtime id "${entry.id}"`);
    }
    runtimeIds.add(entry.id);
    if (entry.id === orchestrator.defaultAgentType) defaultFound = true;

    if (typeof entry.type !== 'string' || !entry.type) {
      throw new Error('Config validation failed: each runtime entry must have a non-empty string "type"');
    }
    if (typeof entry.config !== 'object' || entry.config === null) {
      throw new Error(`Config validation failed: runtime entry "${entry.id}" must have a "config" object`);
    }
  }
  if (!defaultFound) {
    throw new Error(`Config validation failed: defaultAgentType "${orchestrator.defaultAgentType}" not found in runtimes array`);
  }

  // Health check validation
  if (typeof orchestrator.healthCheck.retries !== 'number' || !Number.isInteger(orchestrator.healthCheck.retries) || orchestrator.healthCheck.retries <= 0) {
    throw new Error(`Config validation failed: healthCheck.retries must be a positive integer, got ${orchestrator.healthCheck.retries}`);
  }
  if (typeof orchestrator.healthCheck.intervalMs !== 'number' || orchestrator.healthCheck.intervalMs <= 0) {
    throw new Error(`Config validation failed: healthCheck.intervalMs must be positive, got ${orchestrator.healthCheck.intervalMs}`);
  }
  if (typeof orchestrator.healthCheck.clientTimeoutMs !== 'number' || !Number.isInteger(orchestrator.healthCheck.clientTimeoutMs) || orchestrator.healthCheck.clientTimeoutMs <= 0) {
    throw new Error(`Config validation failed: healthCheck.clientTimeoutMs must be a positive integer, got ${orchestrator.healthCheck.clientTimeoutMs}`);
  }

  // SSE validation
  if (orchestrator.sse) {
    if (typeof orchestrator.sse.enabled !== 'boolean') {
      throw new Error(`Config validation failed: sse.enabled must be a boolean, got ${typeof orchestrator.sse.enabled}`);
    }
    if (typeof orchestrator.sse.reconnectMaxAttempts !== 'number' || !Number.isInteger(orchestrator.sse.reconnectMaxAttempts) || orchestrator.sse.reconnectMaxAttempts <= 0) {
      throw new Error(`Config validation failed: sse.reconnectMaxAttempts must be a positive integer, got ${orchestrator.sse.reconnectMaxAttempts}`);
    }
    if (typeof orchestrator.sse.reconnectBaseMs !== 'number' || orchestrator.sse.reconnectBaseMs <= 0) {
      throw new Error(`Config validation failed: sse.reconnectBaseMs must be positive, got ${orchestrator.sse.reconnectBaseMs}`);
    }
    if (typeof orchestrator.sse.filterHeartbeat !== 'boolean') {
      throw new Error(`Config validation failed: sse.filterHeartbeat must be a boolean, got ${typeof orchestrator.sse.filterHeartbeat}`);
    }
  }

  // Workspace validation
  if (!config.workspace.basePath || typeof config.workspace.basePath !== 'string') {
    throw new Error('Config validation failed: workspace.basePath must be a non-empty string');
  }
  if (typeof config.workspace.enforceCanonicalConfig !== 'boolean') {
    throw new Error(`Config validation failed: workspace.enforceCanonicalConfig must be a boolean, got ${config.workspace.enforceCanonicalConfig}`);
  }
  if (config.workspace.maxSizeBytes !== undefined) {
    if (typeof config.workspace.maxSizeBytes !== 'number' || !Number.isInteger(config.workspace.maxSizeBytes) || config.workspace.maxSizeBytes < 0) {
      throw new Error(`Config validation failed: workspace.maxSizeBytes must be a non-negative integer, got ${config.workspace.maxSizeBytes}`);
    }
  }
  if (config.workspace.storage) {
    if (config.workspace.storage.type !== 'local') {
      throw new Error(`Config validation failed: workspace.storage.type must be "local", got ${config.workspace.storage.type}`);
    }
  }
}

export function readJSON(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf-8');
  return parseJSONC(raw) as Record<string, unknown>;
}

export function loadCanonicalConfig(enforce: boolean): Record<string, unknown> {
  const path = existsSync(CANONICAL_OPECONFIG_PATH)
    ? CANONICAL_OPECONFIG_PATH
    : CANONICAL_OPECONFIG_EXAMPLE_PATH;
  if (!existsSync(path)) {
    if (enforce) {
      throw new Error(
        `Canonical opencode config not found at ${CANONICAL_OPECONFIG_PATH} or ${CANONICAL_OPECONFIG_EXAMPLE_PATH}. ` +
        'Create it or set workspace.enforceCanonicalConfig to false.'
      );
    }
    return {};
  }
  return readJSON(path) as Record<string, unknown>;
}

export function defaultConfig(): AgentOrchestratorConfig {
  return {
    server: {
      port: 0,
      host: '127.0.0.1',
      shutdownTimeoutMs: 15000,
    },
    websocket: {
      heartbeatIntervalMs: 30000,
      idleTimeoutMs: 600000,
    },
    orchestrator: {
      maxInstances: 10,
      idleTimeoutMs: 600000,
      idleSweepIntervalMs: 60000,
      portRange: { start: 30000, end: 30100, allowDynamicFallback: true },
      defaultAgentType: 'opencode-direct',
      runtimes: [{ id: 'opencode-direct', type: 'direct', config: { binary: 'opencode', version: '1.17.8' } }],
      healthCheck: { retries: 10, intervalMs: 500, clientTimeoutMs: 5000 },
      sse: { enabled: true, reconnectMaxAttempts: 10, reconnectBaseMs: 1000, filterHeartbeat: true },
    },
    workspace: {
      basePath: './workspace',
      enforceCanonicalConfig: true,
      maxSizeBytes: 50 * 1024 * 1024,
      storage: { type: 'local' },
    },
  };
}

function mergeDefaults<T>(defaults: T, overrides: unknown): T {
  if (overrides === undefined || overrides === null) return defaults;
  if (typeof defaults !== 'object' || typeof overrides !== 'object') return overrides as T;
  if (Array.isArray(defaults) || Array.isArray(overrides)) return overrides as T;

  const result = { ...(defaults as Record<string, unknown>) };
  for (const key of Object.keys(overrides as Record<string, unknown>)) {
    const overrideVal = (overrides as Record<string, unknown>)[key];
    const defaultVal = (defaults as Record<string, unknown>)[key];
    if (
      overrideVal !== undefined &&
      typeof overrideVal === 'object' && !Array.isArray(overrideVal) &&
      defaultVal !== undefined && typeof defaultVal === 'object' && !Array.isArray(defaultVal)
    ) {
      result[key] = mergeDefaults(defaultVal, overrideVal);
    } else {
      result[key] = overrideVal;
    }
  }
  return result as T;
}

/**
 * Normalize apiKeys from legacy apiKey or apiKeys array.
 * - If apiKeys is set, use it directly.
 * - If only apiKey is set, convert to [{ key, role: 'admin' }].
 * - If neither is set, return undefined (no auth).
 */
export function normalizeApiKeys(serverConfig: ServerConfig): ApiKeyEntry[] | undefined {
  if (serverConfig.apiKeys && serverConfig.apiKeys.length > 0) {
    return serverConfig.apiKeys;
  }
  if (serverConfig.apiKey && serverConfig.apiKey.length >= 8) {
    return [{ key: serverConfig.apiKey, role: 'admin' }];
  }
  return undefined;
}

export function loadConfig(configPath?: string): AgentOrchestratorConfig {
  let resolvedPath: string | undefined;

  if (configPath) {
    if (!existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    resolvedPath = configPath;
  } else {
    const aoConfigPath = join(process.cwd(), 'ao.config.json');
    if (existsSync(aoConfigPath)) {
      resolvedPath = aoConfigPath;
    } else if (existsSync(CONFIG_PATH)) {
      resolvedPath = CONFIG_PATH;
    } else if (existsSync(EXAMPLE_PATH)) {
      console.warn(`[config-loader] ${CONFIG_PATH} not found, falling back to ${EXAMPLE_PATH}. Copy it to use as your config.`);
      resolvedPath = EXAMPLE_PATH;
    }
  }

  let config: AgentOrchestratorConfig;
  if (resolvedPath) {
    const parsed = readJSON(resolvedPath);
    applyEnvOverrides(parsed);
    config = mergeDefaults(defaultConfig(), parsed);
  } else {
    config = defaultConfig();
    applyEnvOverrides(config as unknown as Record<string, unknown>);
  }
  validateConfig(config);
  return config;
}
