import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseJSONC } from 'jsonc-parser';

export interface ServerConfig {
  port: number;
  host: string;
  shutdownTimeoutMs: number;
}

export interface WebSocketConfig {
  heartbeatIntervalMs: number;
  idleTimeoutMs: number;
}

export interface HealthCheckConfig {
  retries: number;
  intervalMs: number;
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
  runtime: string;
  runtimeConfig: Record<string, unknown>;
  agentType: string;
  healthCheck: HealthCheckConfig;
}

export interface WorkspaceConfig {
  basePath: string;
  enforceCanonicalConfig: boolean;
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
      if (!current[key] || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }

    const leafKey = path[path.length - 1];
    const trimmed = envValue?.trim() ?? '';
    const numValue = Number(trimmed);
    const isValidNumber =
      trimmed !== '' &&
      Number.isFinite(numValue) &&
      !Number.isNaN(numValue);
    current[leafKey] = isValidNumber ? numValue : envValue;
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

  // WebSocket validation
  if (typeof websocket.heartbeatIntervalMs !== 'number' || websocket.heartbeatIntervalMs <= 0) {
    throw new Error(`Config validation failed: websocket.heartbeatIntervalMs must be positive, got ${websocket.heartbeatIntervalMs}`);
  }
  if (typeof websocket.idleTimeoutMs !== 'number' || websocket.idleTimeoutMs <= 0) {
    throw new Error(`Config validation failed: websocket.idleTimeoutMs must be positive, got ${websocket.idleTimeoutMs}`);
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

  // Health check validation
  if (typeof orchestrator.healthCheck.retries !== 'number' || !Number.isInteger(orchestrator.healthCheck.retries) || orchestrator.healthCheck.retries <= 0) {
    throw new Error(`Config validation failed: healthCheck.retries must be a positive integer, got ${orchestrator.healthCheck.retries}`);
  }
  if (typeof orchestrator.healthCheck.intervalMs !== 'number' || orchestrator.healthCheck.intervalMs <= 0) {
    throw new Error(`Config validation failed: healthCheck.intervalMs must be positive, got ${orchestrator.healthCheck.intervalMs}`);
  }

  // Workspace validation
  if (!config.workspace.basePath || typeof config.workspace.basePath !== 'string') {
    throw new Error('Config validation failed: workspace.basePath must be a non-empty string');
  }
  if (typeof config.workspace.enforceCanonicalConfig !== 'boolean') {
    throw new Error(`Config validation failed: workspace.enforceCanonicalConfig must be a boolean, got ${config.workspace.enforceCanonicalConfig}`);
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
      runtime: 'direct',
      runtimeConfig: { binary: 'opencode' },
      agentType: 'opencode',
      healthCheck: { retries: 10, intervalMs: 500 },
    },
    workspace: {
      basePath: './workspace',
      enforceCanonicalConfig: true,
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

export function loadConfig(configPath?: string): AgentOrchestratorConfig {
  let resolvedPath: string | undefined;

  if (configPath) {
    if (!existsSync(configPath)) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    resolvedPath = configPath;
  } else if (existsSync(CONFIG_PATH)) {
    resolvedPath = CONFIG_PATH;
  } else if (existsSync(EXAMPLE_PATH)) {
    console.warn(`[config-loader] ${CONFIG_PATH} not found, falling back to ${EXAMPLE_PATH}. Copy it to use as your config.`);
    resolvedPath = EXAMPLE_PATH;
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
