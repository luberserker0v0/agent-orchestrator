import { RuntimeFactory } from '../agent-runtime/runtime-factory.js';
import { RuntimeManager } from '../agent-runtime/runtime-manager.js';
import { RuntimeRegistry } from '../agent-runtime/registry.js';
import { DirectRuntime } from '../agent-runtime/runtimes/direct.js';
import { DockerRuntime } from '../agent-runtime/runtimes/docker.js';
import { KubernetesRuntime } from '../agent-runtime/runtimes/kubernetes.js';
import type { AgentOrchestratorConfig } from '../config-loader.js';
import { validateDockerLoggingConfig, validateSessionStorageConfig } from '../config-loader.js';
import { PortPool } from '../orchestrator/port-pool.js';
import { logger } from '../utils/logger.js';

export interface RuntimeEnvironment {
  registry: RuntimeRegistry;
  manager: RuntimeManager;
}

export function createRuntimeEnvironment(config: AgentOrchestratorConfig): RuntimeEnvironment {
  const factory = createRuntimeFactory();
  const registry = new RuntimeRegistry();
  const portPool = new PortPool(
    config.orchestrator.portRange.start,
    config.orchestrator.portRange.end,
    config.orchestrator.portRange.allowDynamicFallback,
  );
  registerConfiguredRuntimes(config, factory, registry, portPool);
  logger.info(`Agent runtimes registered: ${registry.list().join(', ')}`);
  return {
    registry,
    manager: new RuntimeManager(portPool, registry, config.orchestrator.defaultAgentType),
  };
}

function createRuntimeFactory(): RuntimeFactory {
  const factory = new RuntimeFactory();
  factory.register('direct', DirectRuntime, runtimeConfig => {
    const config = runtimeConfig as Record<string, unknown>;
    return [
      ...(config.binary !== undefined && typeof config.binary !== 'string'
        ? ['"binary" must be a string']
        : []),
      ...validateSessionStorageConfig(config.sessionStorage),
    ];
  });
  factory.register('docker', DockerRuntime, runtimeConfig => {
    const config = runtimeConfig as Record<string, unknown>;
    return [
      ...(!config.image || typeof config.image !== 'string' ? ['"image" is required'] : []),
      ...(config.networkMode !== undefined && typeof config.networkMode !== 'string'
        ? ['"networkMode" must be a string']
        : []),
      ...validateSessionStorageConfig(config.sessionStorage),
      ...validateDockerLoggingConfig(config.logging),
    ];
  });
  factory.register('kubernetes', KubernetesRuntime, validateKubernetesRuntimeConfig);
  return factory;
}

function validateKubernetesRuntimeConfig(runtimeConfig: unknown): string[] {
  const config = runtimeConfig as Record<string, unknown>;
  const errors: string[] = [];
  if (!config.image || typeof config.image !== 'string') errors.push('"image" is required');
  if (config.namespace !== undefined && typeof config.namespace !== 'string') errors.push('"namespace" must be a string');
  if (config.instanceHost !== undefined && typeof config.instanceHost !== 'string') errors.push('"instanceHost" must be a string');
  if (config.nodeName !== undefined && typeof config.nodeName !== 'string') errors.push('"nodeName" must be a string');
  if (config.sessionMode !== undefined && config.sessionMode !== 'xdg' && config.sessionMode !== 'sqlite') {
    errors.push('"sessionMode" must be "xdg" or "sqlite"');
  }
  if (config.podReadyTimeoutMs !== undefined && (
    !Number.isInteger(config.podReadyTimeoutMs) || (config.podReadyTimeoutMs as number) <= 0
  )) {
    errors.push('"podReadyTimeoutMs" must be a positive integer');
  }
  return errors;
}

function registerConfiguredRuntimes(
  config: AgentOrchestratorConfig,
  factory: RuntimeFactory,
  registry: RuntimeRegistry,
  portPool: PortPool,
): void {
  for (const entry of config.orchestrator.runtimes) {
    const errors = factory.validateConfig(entry.type, entry.config);
    if (errors.length > 0 || !factory.hasType(entry.type)) {
      const message = errors.length > 0
        ? `Config validation failed: ${errors.join('; ')}`
        : `Unknown runtime type: "${entry.type}"`;
      logger.warn(`Runtime "${entry.id}" (type: ${entry.type}) is invalid: ${message}`);
      registry.registerInvalid(entry.id, message);
      continue;
    }
    try {
      registerRuntime(config, factory, registry, portPool, entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Runtime "${entry.id}" (type: ${entry.type}) is invalid: ${message}`);
      registry.registerInvalid(entry.id, message);
    }
  }
}

function registerRuntime(
  config: AgentOrchestratorConfig,
  factory: RuntimeFactory,
  registry: RuntimeRegistry,
  portPool: PortPool,
  entry: AgentOrchestratorConfig['orchestrator']['runtimes'][number],
): void {
  const runtime = factory.create(entry.type, portPool, {
    ...entry.config,
    ...(config.cleanup.ownerId ? { cleanupOwnerId: config.cleanup.ownerId } : {}),
  });
  if (config.cleanup.ownerId && 'setCleanupOwnerId' in runtime && typeof runtime.setCleanupOwnerId === 'function') {
    runtime.setCleanupOwnerId(config.cleanup.ownerId);
  }
  registry.register(entry.id, runtime);
}
