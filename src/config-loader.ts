import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ServerConfig {
  port: number;
  host: string;
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

export interface AgentSwitchConfig {
  server: ServerConfig;
  websocket: WebSocketConfig;
  orchestrator: OrchestratorConfig;
  workspace: WorkspaceConfig;
}

const CONFIG_PATH = join(process.cwd(), 'config', 'agentswitch.json');

function applyEnvOverrides(config: Record<string, unknown>, prefix = 'AGENTSWITCH'): void {
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

export function loadConfig(): AgentSwitchConfig {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  applyEnvOverrides(parsed);
  return parsed as unknown as AgentSwitchConfig;
}
