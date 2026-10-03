import { randomBytes } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { OrchestratorConfig } from '../config-loader.js';
import { WorkspaceFactory } from './workspace-factory.js';
import { RuntimeManager, type InstanceInfo } from '../agent-runtime/runtime-manager.js';
import { instanceEvictionsTotal, instanceIdleTimeoutsTotal } from '../metrics/registry.js';

export type { InstanceInfo };

function generatePassword(): string {
  return randomBytes(16).toString('hex');
}

export class InstanceManager {
  private config: OrchestratorConfig;
  private workspaceFactory: WorkspaceFactory;
  private runtimeManager: RuntimeManager;
  private idleSweepTimer?: NodeJS.Timeout;
  private pendingStarts = new Set<string>();

  constructor(config: OrchestratorConfig, workspaceFactory: WorkspaceFactory, runtimeManager: RuntimeManager) {
    this.config = config;
    this.workspaceFactory = workspaceFactory;
    this.runtimeManager = runtimeManager;
    this.startIdleSweep();
  }

  async createInstance(id: string, agentType?: string): Promise<InstanceInfo> {
    if (this.runtimeManager.has(id) || this.pendingStarts.has(id)) {
      throw new Error(`Instance already exists: ${id}`);
    }

    // Reserve capacity synchronously before the first await. Without this,
    // simultaneous starts all observe the same map size and can exceed the
    // configured hard limit.
    this.pendingStarts.add(id);

    try {
      if (this.runtimeManager.size + this.pendingStarts.size > this.config.maxInstances) {
        await this.evictLRU();
      }

      const resolvedAgentType = agentType ?? this.config.defaultAgentType;
      let workspace;
      try {
        if (await this.workspaceFactory.hasWorkspace(id)) {
          workspace = await this.workspaceFactory.ensure(id);
        } else {
          workspace = await this.workspaceFactory.create(id, resolvedAgentType);
        }
      } catch (err) {
        throw new Error(`Failed to create workspace: ${(err as Error).message}`, { cause: err });
      }

      const password = generatePassword();

      return await this.runtimeManager.start(
        id,
        workspace.path,
        { username: 'opencode', password },
        this.config.healthCheck,
        resolvedAgentType,
        workspace.runtimeAccess,
      );
    } finally {
      this.pendingStarts.delete(id);
    }
  }

  getInstance(id: string): InstanceInfo | undefined {
    return this.runtimeManager.getInstance(id);
  }

  setSessionId(id: string, sessionId: string): void {
    this.runtimeManager.setSessionId(id, sessionId);
  }

  listInstances(): Pick<InstanceInfo, 'id' | 'port' | 'lastUsedAt'>[] {
    return this.runtimeManager.listInstances();
  }

  destroyInstance(id: string): Promise<void> {
    return this.runtimeManager.destroyInstance(id);
  }

  stopInstance(id: string): Promise<void> {
    return this.runtimeManager.destroyInstance(id);
  }

  async restartInstance(id: string, agentType?: string): Promise<void> {
    return this.runtimeManager.restartInstance(id, agentType ?? this.config.defaultAgentType, this.config.healthCheck);
  }

  cleanupOrphanContainers(): Promise<void> {
    return this.runtimeManager.cleanupOrphanContainers();
  }

  deletePersistentData(id: string, agentType?: string): Promise<void> {
    return this.runtimeManager.deletePersistentData(id, agentType);
  }

  destroy(): void {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = undefined;
    }
  }

  // ── Private ─────────────────────────────────────────────

  private async evictLRU(): Promise<void> {
    const lruId = this.runtimeManager.getLRUCandidateId();
    if (!lruId) {
      throw new Error('Maximum instance capacity is reserved by instances that are still starting');
    }
    instanceEvictionsTotal.inc();
    logger.warn(`LRU eviction: destroying instance ${lruId}`);
    await this.runtimeManager.destroyInstance(lruId);
  }

  private startIdleSweep(): void {
    if (this.config.idleTimeoutMs === 0) {
      logger.info('Idle sweep disabled (idleTimeoutMs=0)');
      return;
    }
    this.idleSweepTimer = setInterval(() => {
      const ids = this.runtimeManager.findIdleInstanceIds(this.config.idleTimeoutMs);
      for (const id of ids) {
        instanceIdleTimeoutsTotal.inc();
        logger.warn(`Idle timeout: destroying instance ${id}`);
        this.runtimeManager.destroyInstance(id).catch(() => {});
      }
    }, this.config.idleSweepIntervalMs);
    logger.info(`Idle sweep started: interval=${this.config.idleSweepIntervalMs}ms, timeout=${this.config.idleTimeoutMs}ms`);
  }
}
