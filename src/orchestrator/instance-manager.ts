import { type ChildProcess, exec } from 'node:child_process';
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
        this.cleanupInstance(id);
      });
      proc.on('error', (err: Error) => {
        logger.error(`[${id}] process error: ${err.message}`);
        this.cleanupInstance(id);
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
      await this.cleanupInstance(oldest.id);
    }
  }

  private async cleanupInstance(id: string): Promise<void> {
    const inst = this.instances.get(id);
    if (!inst) {
      logger.warn(`[${id}] cleanupInstance: no instance found in map (already cleaned up)`);
      return;
    }

    this.instances.delete(id);

    if (inst.dispose) {
      await inst.dispose();
      logger.info(`[${id}] dispose completed`);
    } else if (inst.process) {
      const pid = inst.process.pid;
      logger.info(`[${id}] killing process PID ${pid}...`);
      const runtime = this.runtimes.get(this.config.agentType);
      if (runtime) {
        await this.safeKill(runtime, inst.process);
        let exited = inst.process.exitCode !== null;
        if (!exited) {
          await this.waitForExit(inst.process, 5000);
          exited = inst.process.exitCode !== null;
        }
        if (!exited) {
          logger.warn(`[${id}] PID ${pid} still alive after SIGTERM, sending SIGKILL`);
          await this.safeKill(runtime, inst.process, 'SIGKILL');
          await this.waitForExit(inst.process, 5000);
        }
        logger.info(`[${id}] PID ${pid} kill complete, exitCode=${inst.process.exitCode}, killed=${inst.process.killed}`);
        // Verify process is actually dead at OS level (Windows: tasklist check)
        exec(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, (err, stdout) => {
          const alive = stdout.includes(String(pid));
          logger.info(`[${id}] OS-level PID ${pid} alive=${alive}${alive ? ' (SURVIVED!)' : ''}`);
          if (alive) {
            logger.warn(`[${id}] PID ${pid} survived kill! Checking children...`);
            exec(`wmic process where "ParentProcessId=${pid}" get ProcessId /FORMAT:CSV`, (err2, stdout2) => {
              const children = stdout2.split('\n').filter(l => l.trim() && !l.includes('ProcessId')).map(l => l.trim()).filter(Boolean);
              logger.info(`[${id}] surviving children of PID ${pid}: ${children.length ? children.join(', ') : 'none'}`);
            });
          }
        });
      }
    }

    this.portPool.release(inst.port);
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
    await this.cleanupInstance(id);
  }

  async stopInstance(id: string): Promise<void> {
    await this.cleanupInstance(id);
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
          this.cleanupInstance(inst.id).catch(() => {});
        }
      }
    }, this.config.idleSweepIntervalMs);
    logger.info(`Idle sweep started: interval=${this.config.idleSweepIntervalMs}ms, timeout=${this.config.idleTimeoutMs}ms`);
  }

}
