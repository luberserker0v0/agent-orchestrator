import { exec } from 'node:child_process';
import { logger } from '../utils/logger.js';
import type { AgentClient, InstanceHandle, HealthCheckConfig } from './types.js';
import { RuntimeRegistry } from './registry.js';
import { PortPool } from '../orchestrator/port-pool.js';
import { instancesActive, instancesTotalCreated, instancesErrorsTotal, instanceSpawnDurationSeconds } from '../metrics/registry.js';

export interface InstanceInfo {
  id: string;
  port: number;
  workspacePath: string;
  handle?: InstanceHandle;
  client: AgentClient;
  sessionId?: string;
  lastUsedAt: number;
}

export class RuntimeManager {
  private instances: Map<string, InstanceInfo> = new Map();
  private portPool: PortPool;
  private runtimes: RuntimeRegistry;
  private defaultAgentType: string;

  constructor(portPool: PortPool, runtimes: RuntimeRegistry, defaultAgentType: string) {
    this.portPool = portPool;
    this.runtimes = runtimes;
    this.defaultAgentType = defaultAgentType;
  }

  async spawn(
    id: string,
    workspacePath: string,
    auth: { username: string; password: string },
    healthCheckConfig: HealthCheckConfig,
    agentType?: string,
  ): Promise<InstanceInfo> {
    const runtime = this.runtimes.getOrThrow(agentType ?? this.defaultAgentType);

    const endSpawnTimer = instanceSpawnDurationSeconds.startTimer();
    let client: AgentClient;
    let port: number;
    let handle: InstanceHandle | undefined;
    try {
      ({ client, port, handle } = await runtime.spawn(id, workspacePath, auth, healthCheckConfig));
    } catch (err) {
      instancesErrorsTotal.inc({ type: 'spawn' });
      throw err;
    } finally {
      endSpawnTimer();
    }

    if (handle) {
      handle.onExit((_code: number | null) => {
        logger.warn(`[${id}] process exited`);
        this.cleanupInstance(id);
      });
    }

    const instance: InstanceInfo = {
      id,
      port,
      workspacePath,
      handle,
      client,
      lastUsedAt: Date.now(),
    };

    this.instances.set(id, instance);
    instancesActive.inc();
    instancesTotalCreated.inc();
    logger.info(`Instance ${id} ready on port ${port}`);
    return instance;
  }

  destroyInstance(id: string): Promise<void> {
    return this.cleanupInstance(id);
  }

  async restartInstance(id: string, agentType?: string, healthCheckConfig?: HealthCheckConfig): Promise<void> {
    const inst = this.instances.get(id);
    if (!inst) throw new Error(`Instance not found: ${id}`);

    const runtime = this.runtimes.get(agentType ?? this.defaultAgentType);
    if (!runtime?.restart) {
      throw new Error(`Runtime ${agentType ?? this.defaultAgentType} does not support restart`);
    }

    await runtime.restart(id, inst.client, healthCheckConfig ?? { retries: 10, intervalMs: 500, clientTimeoutMs: 5000 });
    inst.lastUsedAt = Date.now();
  }

  async cleanupOrphanContainers(): Promise<void> {
    const runtimes = this.runtimes.getAll();
    await Promise.all(runtimes.map((r) => r.cleanupOrphans?.()));
  }

  // ── Queries ─────────────────────────────────────────────

  has(id: string): boolean {
    return this.instances.has(id);
  }

  get size(): number {
    return this.instances.size;
  }

  hasAgentType(type: string): boolean {
    return this.runtimes.has(type);
  }

  listAgentTypes(): string[] {
    return this.runtimes.list();
  }

  getLRUCandidateId(): string | undefined {
    let oldest: InstanceInfo | null = null;
    for (const inst of this.instances.values()) {
      if (!oldest || inst.lastUsedAt < oldest.lastUsedAt) {
        oldest = inst;
      }
    }
    return oldest?.id;
  }

  findIdleInstanceIds(idleTimeoutMs: number): string[] {
    if (idleTimeoutMs === 0) return [];
    const now = Date.now();
    const ids: string[] = [];
    for (const inst of this.instances.values()) {
      if (now - inst.lastUsedAt > idleTimeoutMs) {
        ids.push(inst.id);
      }
    }
    return ids;
  }

  // ── Accessors ───────────────────────────────────────────

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

  // ── Internal ────────────────────────────────────────────

  private async cleanupInstance(id: string): Promise<void> {
    const inst = this.instances.get(id);
    if (!inst) {
      logger.warn(`[${id}] cleanupInstance: no instance found in map (already cleaned up)`);
      return;
    }

    this.instances.delete(id);

    if (inst.handle) {
      const pid = inst.handle.pid;
      if (pid !== undefined) {
        logger.info(`[${id}] killing process PID ${pid}...`);
      }
      await this.safeKill(inst.handle, 'SIGTERM');
      let exited = inst.handle.exitCode !== null;
      if (!exited) {
        await inst.handle.waitForExit(5000);
        exited = inst.handle.exitCode !== null;
      }
      if (!exited) {
        logger.warn(`[${id}] sending SIGKILL`);
        await this.safeKill(inst.handle, 'SIGKILL');
        await inst.handle.waitForExit(5000);
      }
      if (pid !== undefined) {
        logger.info(`[${id}] kill complete, exitCode=${inst.handle.exitCode}`);
        // Verify process is actually dead at OS level (Windows: tasklist check)
        exec(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, (_err, stdout) => {
          const alive = stdout.includes(String(pid));
          logger.info(`[${id}] OS-level PID ${pid} alive=${alive}${alive ? ' (SURVIVED!)' : ''}`);
          if (alive) {
            logger.warn(`[${id}] PID ${pid} survived kill! Checking children...`);
            exec(`wmic process where "ParentProcessId=${pid}" get ProcessId /FORMAT:CSV`, (_err2, stdout2) => {
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

  private async safeKill(handle: InstanceHandle, signal?: string): Promise<void> {
    try {
      await handle.kill(signal);
    } catch (err) {
      logger.warn(`kill error: ${(err as Error).message}`);
    }
  }
}
