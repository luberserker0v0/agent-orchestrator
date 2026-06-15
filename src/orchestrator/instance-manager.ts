import { type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { AgentClient } from '../agent-runtime/types.js';
import { RuntimeRegistry } from '../agent-runtime/registry.js';
import type { OrchestratorConfig } from '../config-loader.js';
import { PortPool } from './port-pool.js';
import { WorkspaceFactory, type WorkspaceInfo } from './workspace-factory.js';
import { instancesActive, instancesTotalCreated } from '../metrics/registry.js';

async function retryRm(dirPath: string, maxRetries = 10): Promise<void> {
  let lastErr: Error | undefined;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await rm(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err as Error;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') {
        throw err;
      }
      if (i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, Math.min(200 * Math.pow(2, i), 2000)));
      }
    }
  }
  throw lastErr;
}

function generatePassword(): string {
  return randomBytes(16).toString('hex');
}

export interface InstanceInfo {
  id: string;
  port: number;
  workspacePath: string;
  process?: ChildProcess;
  client: AgentClient;
  dispose?: () => Promise<void>;
  sessionId?: string;
  lastUsedAt: number;
}

export class InstanceManager {
  private instances: Map<string, InstanceInfo> = new Map();
  private portPool: PortPool;
  private workspaceFactory: WorkspaceFactory;
  private config: OrchestratorConfig;
  private runtimes: RuntimeRegistry;
  private idleSweepTimer?: NodeJS.Timeout;

  constructor(config: OrchestratorConfig, workspaceFactory: WorkspaceFactory, runtimes: RuntimeRegistry) {
    this.config = config;
    this.runtimes = runtimes;
    this.portPool = new PortPool(config.portRange.start, config.portRange.end, config.portRange.allowDynamicFallback);
    this.workspaceFactory = workspaceFactory;
    this.startIdleSweep();
  }

  async createInstance(id: string, agentType = this.config.agentType): Promise<InstanceInfo> {
    if (this.instances.has(id)) {
      throw new Error(`Instance already exists: ${id}`);
    }

    const runtime = this.runtimes.getOrThrow(agentType);

    // Strict maxInstances enforcement: evict LRU if at capacity
    if (this.instances.size >= this.config.maxInstances) {
      await this.evictLRU();
    }

    // Try allocate; if exhausted, evict LRU and retry once
    let port = await this.portPool.allocate();
    if (port === null) {
      if (this.instances.size > 0) {
        await this.evictLRU();
        port = await this.portPool.allocate();
      }
      if (port === null) {
        throw new Error('No available ports in pool');
      }
    }

    let workspace: WorkspaceInfo;
    try {
      if (this.workspaceFactory.hasWorkspace(id)) {
        workspace = this.workspaceFactory.ensure(id);
      } else {
        workspace = this.workspaceFactory.create(id);
      }
    } catch (err) {
      this.portPool.release(port);
      throw new Error(`Failed to create workspace: ${(err as Error).message}`, { cause: err });
    }

    const password = generatePassword();

    const { process: proc, client, dispose } = await runtime.spawn(
      id,
      port,
      workspace.path,
      { username: 'opencode', password },
      { retries: this.config.healthCheck.retries, intervalMs: this.config.healthCheck.intervalMs, clientTimeoutMs: 5000 },
    );

    if (proc) {
      proc.on('exit', (code: number | null) => {
        logger.warn(`[${id}] process exited with code ${code}`);
        this.cleanupInstance(id, false);
      });
      proc.on('error', (err: Error) => {
        logger.error(`[${id}] process error: ${err.message}`);
        this.cleanupInstance(id, false);
      });
    }

    const instance: InstanceInfo = {
      id,
      port,
      workspacePath: workspace.path,
      process: proc,
      client,
      dispose,
      lastUsedAt: Date.now(),
    };

    this.instances.set(id, instance);
    instancesActive.inc();
    instancesTotalCreated.inc();
    logger.info(`Instance ${id} ready on port ${port}`);
    return instance;
  }

  getInstance(id: string): InstanceInfo | undefined {
    const inst = this.instances.get(id);
    if (inst) {
      inst.lastUsedAt = Date.now();
    }
    return inst;
  }

  setSessionId(id: string, sessionId: string): void {
    const inst = this.instances.get(id);
    if (inst) {
      inst.sessionId = sessionId;
    }
  }

  listInstances(): Pick<InstanceInfo, 'id' | 'port' | 'lastUsedAt'>[] {
    return Array.from(this.instances.values()).map((inst) => ({
      id: inst.id,
      port: inst.port,
      lastUsedAt: inst.lastUsedAt,
    }));
  }

  private async evictLRU(): Promise<void> {
    if (this.instances.size === 0) return;

    let oldest: InstanceInfo | null = null;
    for (const inst of this.instances.values()) {
      if (!oldest || inst.lastUsedAt < oldest.lastUsedAt) {
        oldest = inst;
      }
    }

    if (oldest) {
      logger.warn(`LRU eviction: destroying instance ${oldest.id} (idle since ${new Date(oldest.lastUsedAt).toISOString()})`);
      await this.cleanupInstance(oldest.id, true);
    }
  }

  private async cleanupInstance(id: string, removeWorkspace: boolean): Promise<void> {
    const inst = this.instances.get(id);
    if (!inst) return;

    this.instances.delete(id);

    if (inst.dispose) {
      await inst.dispose();
    } else if (inst.process) {
      const runtime = this.runtimes.get(this.config.agentType);
      if (runtime) {
        await this.safeKill(runtime, inst.process);
        await this.waitForExit(inst.process, 5000);
        if (!inst.process.killed && inst.process.exitCode === null) {
          await this.safeKill(runtime, inst.process, 'SIGKILL');
        }
      }
    }

    this.portPool.release(inst.port);

    if (removeWorkspace) {
      try {
        await retryRm(inst.workspacePath);
        logger.info(`Workspace removed: ${inst.workspacePath}`);
      } catch (err) {
        logger.error(`Failed to remove workspace: ${inst.workspacePath}`, err);
      }
    }

    instancesActive.dec();
    logger.info(`Instance ${id} destroyed`);
  }

  private async safeKill(runtime: { kill(process?: ChildProcess, signal?: string | number): Promise<void> }, process: ChildProcess, signal?: string | number): Promise<void> {
    try {
      await runtime.kill(process, signal);
    } catch (err) {
      logger.warn(`kill error: ${(err as Error).message}`);
    }
  }

  private waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
    if (proc.exitCode !== null || proc.killed) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  destroy(): void {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = undefined;
    }
  }

  async destroyInstance(id: string): Promise<void> {
    await this.cleanupInstance(id, true);
  }

  async stopInstance(id: string): Promise<void> {
    await this.cleanupInstance(id, false);
  }

  async restartInstance(id: string): Promise<void> {
    const inst = this.instances.get(id);
    if (!inst) throw new Error(`Instance not found: ${id}`);

    const runtime = this.runtimes.get(this.config.agentType);
    if (!runtime?.restart) {
      throw new Error(`Runtime ${this.config.agentType} does not support restart`);
    }

    await runtime.restart(id, inst.client);
    inst.lastUsedAt = Date.now();
  }

  async cleanupOrphanContainers(): Promise<void> {
    const runtimes = this.runtimes.getAll();
    await Promise.all(runtimes.map((r) => r.cleanupOrphans?.()));
  }

  private startIdleSweep(): void {
    if (this.config.idleTimeoutMs === 0) {
      logger.info('Idle sweep disabled (idleTimeoutMs=0)');
      return;
    }
    this.idleSweepTimer = setInterval(() => {
      const now = Date.now();
      for (const inst of this.instances.values()) {
        if (now - inst.lastUsedAt > this.config.idleTimeoutMs) {
          logger.warn(`Idle timeout: destroying instance ${inst.id} (idle for ${now - inst.lastUsedAt}ms)`);
          this.cleanupInstance(inst.id, true).catch(() => {});
        }
      }
    }, this.config.idleSweepIntervalMs);
    logger.info(`Idle sweep started: interval=${this.config.idleSweepIntervalMs}ms, timeout=${this.config.idleTimeoutMs}ms`);
  }

}
