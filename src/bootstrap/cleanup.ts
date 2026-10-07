import { DEFAULT_SESSION_CLEANUP_OWNER } from '../agent-runtime/session-storage.js';
import { KubernetesRuntime } from '../agent-runtime/runtimes/kubernetes.js';
import { CleanupManager } from '../cleanup/cleanup-manager.js';
import { FileLogCleanupProvider } from '../cleanup/file-log-provider.js';
import { KubernetesPersistentDataCleanupProvider } from '../cleanup/kubernetes-persistent-data-provider.js';
import { LocalPersistentDataProvider } from '../cleanup/local-persistent-data-provider.js';
import type { CleanupProvider } from '../cleanup/types.js';
import type { AgentOrchestratorConfig } from '../config-loader.js';
import type { StorageBackend } from '../storage/types.js';
import { logger } from '../utils/logger.js';
import type { ApplicationServices } from './application-services.js';
import type { RuntimeEnvironment } from './runtime-environment.js';

export function createCleanupManager(
  config: AgentOrchestratorConfig,
  storage: StorageBackend,
  runtimes: RuntimeEnvironment,
  services: ApplicationServices,
): CleanupManager {
  const providers: CleanupProvider[] = [new FileLogCleanupProvider(config.logging.file.enabled)];
  const roots = config.orchestrator.runtimes.flatMap(entry => {
    if ((entry.type !== 'direct' && entry.type !== 'docker') || !entry.config.sessionStorage) return [];
    return [{ runtimeId: entry.id, config: entry.config.sessionStorage }];
  });
  providers.push(new LocalPersistentDataProvider({
    enabled: config.cleanup.orphanedData.enabled,
    retryPendingDeletes: roots.length > 0,
    ownerId: config.cleanup.ownerId ?? DEFAULT_SESSION_CLEANUP_OWNER,
    gracePeriodMs: config.cleanup.orphanedData.gracePeriodMs,
    roots,
    isProtected: async id => services.conversationState.has(id)
      || runtimes.manager.has(id)
      || await storage.hasWorkspace(id),
    isRuntimeActive: id => runtimes.manager.has(id),
    withConversationLock: (id, operation) => services.conversationService.withLifecycleLock(id, operation),
  }));
  addKubernetesCleanupProviders(config, storage, runtimes, services, providers);
  return new CleanupManager(providers, config.cleanup.sweepIntervalMs);
}

function addKubernetesCleanupProviders(
  config: AgentOrchestratorConfig,
  storage: StorageBackend,
  runtimes: RuntimeEnvironment,
  services: ApplicationServices,
  providers: CleanupProvider[],
): void {
  const authority = services.statusReporter.cleanupContext();
  if (!authority) {
    warnIfKubernetesCleanupUnavailable(config);
    return;
  }
  const seenNamespaces = new Set<string>();
  for (const entry of config.orchestrator.runtimes) {
    const runtime = runtimes.registry.get(entry.id);
    if (entry.type !== 'kubernetes' || !(runtime instanceof KubernetesRuntime)) continue;
    const context = runtime.persistentDataCleanupContext();
    if (seenNamespaces.has(context.namespace)) continue;
    seenNamespaces.add(context.namespace);
    providers.push(new KubernetesPersistentDataCleanupProvider({
      orphanCleanupEnabled: config.cleanup.orphanedData.enabled,
      retryPendingDeletes: true,
      clusterStatusReportingEnabled: true,
      namespace: context.namespace,
      authorityNamespace: authority.namespace,
      ownerId: context.ownerId,
      gracePeriodMs: config.cleanup.orphanedData.gracePeriodMs,
      api: context.api,
      objectsApi: authority.api,
      runtimeId: entry.id,
      hasLiveConversation: id => services.conversationState.has(id) || runtimes.manager.has(id),
      hasLocalWorkspace: id => storage.hasWorkspace(id),
      withConversationLock: (id, operation) => services.conversationService.withLifecycleLock(id, operation),
    }));
  }
}

function warnIfKubernetesCleanupUnavailable(config: AgentOrchestratorConfig): void {
  if (config.cleanup.orphanedData.enabled
    && config.orchestrator.runtimes.some(entry => entry.type === 'kubernetes')) {
    logger.warn('Kubernetes orphan cleanup is unavailable because cluster status reporting is not healthy');
  }
}
