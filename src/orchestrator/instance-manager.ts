import { type ChildProcess } from 'node:child_process';
import { spawn } from 'cross-spawn';
import treeKill from 'tree-kill';
import { rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { OpenCodeClient } from '../opencode-http/client.js';
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
  client: OpenCodeClient;
  sessionId: string;
  lastUsedAt: number;
  isReady: boolean;
}

export class InstanceManager {
  private instances: Map<string, InstanceInfo> = new Map();
  private portPool: PortPool;
  private workspaceFactory: WorkspaceFactory;
  private config: OrchestratorConfig;
  private idleSweepTimer?: NodeJS.Timeout;

  constructor(config: OrchestratorConfig, workspaceFactory: WorkspaceFactory) {
    this.config = config;
    this.portPool = new PortPool(config.portRange.start, config.portRange.end);
    this.workspaceFactory = workspaceFactory;
    this.startIdleSweep();
  }

  async createInstance(id: string): Promise<InstanceInfo> {
    if (this.instances.has(id)) {
      throw new Error(`Instance already exists: ${id}`);
    }

    // Strict maxInstances enforcement: evict LRU if at capacity
    if (this.instances.size >= this.config.maxInstances) {
      await this.evictLRU();
    }

    // Try allocate; if exhausted, evict LRU and retry once
    let port = this.portPool.allocate();
    if (port === null) {
      if (this.instances.size > 0) {
        await this.evictLRU();
        port = this.portPool.allocate();
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
    const baseUrl = `http://127.0.0.1:${port}`;
    const client = new OpenCodeClient(baseUrl, 'opencode', password);

    logger.info(`Spawning OpenCode instance on port ${port} at ${workspace.path} (binary: ${this.config.opencodeBinary})`);
    const proc = spawn(this.config.opencodeBinary, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      cwd: workspace.path,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        OPENCODE_SERVER_USERNAME: 'opencode',
        OPENCODE_SERVER_PASSWORD: password,
      },
    });

    proc.stdout?.on('data', (data: Buffer) => {
      logger.info(`[OpenCode ${id}] stdout: ${data.toString().trim()}`);
    });
    proc.stderr?.on('data', (data: Buffer) => {
      logger.warn(`[OpenCode ${id}] stderr: ${data.toString().trim()}`);
    });
    proc.on('exit', (code: number | null) => {
      logger.warn(`[OpenCode ${id}] process exited with code ${code}`);
      this.cleanupInstance(id, false);
    });
    proc.on('error', (err: Error) => {
      logger.error(`[OpenCode ${id}] process error: ${err.message}`);
      this.cleanupInstance(id, false);
    });

    // Wait for health check
    let healthy = false;
    for (let i = 0; i < this.config.healthCheck.retries; i++) {
      await this.delay(this.config.healthCheck.intervalMs);
      try {
        const result = await client.health();
        if (result.healthy) {
          healthy = true;
          logger.info(`[OpenCode ${id}] health check passed (version ${result.version})`);
          break;
        } else {
          logger.warn(`[OpenCode ${id}] health check returned healthy=false (attempt ${i + 1})`);
        }
      } catch (err) {
        logger.warn(`[OpenCode ${id}] health check attempt ${i + 1} failed: ${(err as Error).message}`);
      }
    }

    if (!healthy) {
      this.safeKill(proc);
      this.portPool.release(port);
      try { rmSync(workspace.path, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
      throw new Error(`OpenCode instance failed health check after ${this.config.healthCheck.retries} retries`);
    }

    // Create initial session
    let sessionId: string;
    try {
      const session = await client.createSession({ title: `AgentOrchestrator-${id}` });
      sessionId = session.id;
      logger.info(`[OpenCode ${id}] session created: ${sessionId}`);
    } catch (err) {
      this.safeKill(proc);
      this.portPool.release(port);
      try { rmSync(workspace.path, { recursive: true, force: true }); } catch { /* ignore cleanup errors */ }
      throw new Error(`Failed to create OpenCode session: ${(err as Error).message}`, { cause: err });
    }

    const instance: InstanceInfo = {
      id,
      port,
      workspacePath: workspace.path,
      process: proc,
      client,
      sessionId,
      lastUsedAt: Date.now(),
      isReady: true,
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

  async destroyInstance(id: string): Promise<void> {
    await this.cleanupInstance(id, true);
  }

  listInstances(): Pick<InstanceInfo, 'id' | 'port' | 'lastUsedAt' | 'isReady'>[] {
    return Array.from(this.instances.values()).map((inst) => ({
      id: inst.id,
      port: inst.port,
      lastUsedAt: inst.lastUsedAt,
      isReady: inst.isReady,
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
      await this.destroyInstance(oldest.id);
    }
  }

  private async cleanupInstance(id: string, removeWorkspace: boolean): Promise<void> {
    const inst = this.instances.get(id);
    if (!inst) return;

    this.instances.delete(id);

    this.safeKill(inst.process);
    await this.waitForExit(inst.process, 5000);
    this.safeKill(inst.process, 'SIGKILL');

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

  private safeKill(proc: ChildProcess, signal?: string | number): void {
    if (proc.killed || proc.exitCode !== null || proc.pid === undefined) return;
    try {
      treeKill(proc.pid, signal);
    } catch {
      // ignore kill errors (e.g., process already finished)
    }
  }

  private waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
    // If process already exited, resolve immediately
    if (proc.exitCode !== null || proc.killed) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };
      proc.once('exit', onExit);
    });
  }

  destroy(): void {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = undefined;
    }
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
          this.destroyInstance(inst.id).catch(() => {});
        }
      }
    }, this.config.idleSweepIntervalMs);
    logger.info(`Idle sweep started: interval=${this.config.idleSweepIntervalMs}ms, timeout=${this.config.idleTimeoutMs}ms`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
