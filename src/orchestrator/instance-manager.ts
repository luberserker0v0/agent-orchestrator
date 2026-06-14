import { type ChildProcess } from 'node:child_process';
import { spawn } from 'cross-spawn';
import { rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { AgentClient } from '../agent-runtime/types.js';
import { RuntimeRegistry } from '../agent-runtime/registry.js';
import type { OrchestratorConfig } from '../config-loader.js';
import { PortPool } from './port-pool.js';
import { WorkspaceFactory, type WorkspaceInfo } from './workspace-factory.js';
import { instancesActive, instancesTotalCreated } from '../metrics/registry.js';

function generatePassword(): string {
  return randomBytes(16).toString('hex');
}

export interface InstanceInfo {
  id: string;
  port: number;
  workspacePath: string;
  process: ChildProcess;
  client: AgentClient;
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

    // Delegate spawn to the runtime
    const { process: proc, client } = await runtime.spawn(
      id,
      port,
      workspace.path,
      { username: 'opencode', password },
      { retries: this.config.healthCheck.retries, intervalMs: this.config.healthCheck.intervalMs, clientTimeoutMs: 5000 },
    );

    // Attach lifecycle cleanup events for direct processes
    if (this.config.runtime !== 'docker') {
      proc.on('exit', (code: number | null) => {
        logger.warn(`[OpenCode ${id}] process exited with code ${code}`);
        this.cleanupInstance(id, false);
      });
      proc.on('error', (err: Error) => {
        logger.error(`[OpenCode ${id}] process error: ${err.message}`);
        this.cleanupInstance(id, false);
      });
    }

    const instance: InstanceInfo = {
      id,
      port,
      workspacePath: workspace.path,
      process: proc,
      client,
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

    if (this.config.runtime === 'docker') {
      const containerName = `agentorchestrator-${id}`;
      try {
        const rm = spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
        await this.waitForExit(rm, 10000);
      } catch {
        logger.warn(`[Docker ${id}] failed to remove container`);
      }
    } else {
      await this.safeKill(inst.process);
      await this.waitForExit(inst.process, 5000);
      if (!inst.process.killed && inst.process.exitCode === null) {
        await this.safeKill(inst.process, 'SIGKILL');
      }
    }

    this.portPool.release(inst.port);

    if (removeWorkspace) {
      try {
        rmSync(inst.workspacePath, { recursive: true, force: true });
        logger.info(`Workspace removed: ${inst.workspacePath}`);
      } catch (err) {
        logger.error(`Failed to remove workspace: ${inst.workspacePath}`, err);
      }
    }

    instancesActive.dec();
    logger.info(`Instance ${id} destroyed`);
  }

  private async safeKill(process: ChildProcess, signal?: string | number): Promise<void> {
    try {
      const runtime = this.runtimes.get(this.config.agentType);
      if (runtime) {
        await runtime.kill(process, signal);
      }
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

    if (this.config.runtime !== 'docker') {
      throw new Error('restartInstance is only supported for Docker runtime');
    }

    const containerName = `agentorchestrator-${id}`;
    logger.info(`Restarting container ${containerName}...`);

    const restart = spawn('docker', ['restart', containerName], { stdio: 'ignore' });
    await this.waitForExit(restart, 10000);
    if (restart.exitCode !== 0) {
      throw new Error(`docker restart failed for container ${containerName}`);
    }

    let healthy = false;
    for (let i = 0; i < this.config.healthCheck.retries; i++) {
      await this.delay(this.config.healthCheck.intervalMs);
      try {
        const result = await inst.client.health();
        if (result.healthy) {
          healthy = true;
          logger.info(`[OpenCode ${id}] restart health check passed (attempt ${i + 1})`);
          break;
        }
      } catch {
        logger.warn(`[OpenCode ${id}] restart health check attempt ${i + 1} failed`);
      }
    }

    if (!healthy) {
      throw new Error(`Container restart health check failed for ${id} after ${this.config.healthCheck.retries} retries`);
    }

    inst.lastUsedAt = Date.now();
  }

  async cleanupOrphanContainers(): Promise<void> {
    if (this.config.runtime !== 'docker') {
      logger.info('Runtime is not docker, skipping orphan container cleanup');
      return;
    }

    return new Promise<void>((resolve) => {
      const ps = spawn('docker', ['ps', '-a', '--filter', 'name=agentorchestrator-', '--format', '{{.Names}}'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      ps.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      ps.on('error', (err) => {
        logger.error('Failed to list Docker containers for orphan cleanup', err);
        resolve();
      });

      ps.on('exit', () => {
        const names = output.trim().split('\n').filter(Boolean);
        if (names.length === 0) {
          logger.info('No orphan Docker containers found');
          resolve();
          return;
        }

        logger.info(`Found ${names.length} orphan Docker container(s), removing...`);
        let completed = 0;
        for (const name of names) {
          const rm = spawn('docker', ['rm', '-f', name], { stdio: 'ignore' });
          rm.on('error', () => {
            completed++;
            if (completed === names.length) resolve();
          });
          rm.on('exit', () => {
            completed++;
            if (completed === names.length) {
              logger.info(`Cleaned up ${names.length} orphan Docker container(s)`);
              resolve();
            }
          });
        }
      });
    });
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

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
