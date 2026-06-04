import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  };
  opencodeBinary: string;
  healthCheck: HealthCheckConfig;
}

export interface WorkspaceConfig {
  basePath: string;
  defaultPermissions: Record<string, unknown>;
}

export interface AgentOrchestratorConfig {
  server: ServerConfig;
  websocket: WebSocketConfig;
  orchestrator: OrchestratorConfig;
  workspace: WorkspaceConfig;
}

const CONFIG_PATH = join(process.cwd(), 'config', 'agentorchestrator.json');

function applyEnvOverrides(config: Record<string, unknown>, prefix = 'AGENTORCHESTRATOR'): void {
  for (const [envKey, envValue] of Object.entries(process.env)) {
    if (!envKey.startsWith(prefix + '_')) continue;

    const path = envKey
      .slice(prefix.length + 1)
      .split('_')
      .map((part, index) =>
        index === 0 ? part.toLowerCase() : part[0].toLowerCase() + part.slice(1)
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
  const portCount = orchestrator.portRange.end - orchestrator.portRange.start + 1;
  if (orchestrator.maxInstances > portCount) {
    throw new Error(
      `Config validation failed: maxInstances (${orchestrator.maxInstances}) cannot exceed available ports (${portCount}). ` +
      `Either increase portRange or decrease maxInstances.`
    );
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
}

export function loadConfig(): AgentOrchestratorConfig {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  applyEnvOverrides(parsed);
  const config = parsed as unknown as AgentOrchestratorConfig;
  validateConfig(config);
  return config;
}
