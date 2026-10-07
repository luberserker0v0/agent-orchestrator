import { spawn } from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { logger } from '../../utils/logger.js';
import { OpenCodeAgentClient } from '../../opencode-http/client.js';
import { PortPool } from '../../orchestrator/port-pool.js';
import { waitForHealthy } from '../health.js';
import {
  DEFAULT_SESSION_CLEANUP_OWNER,
  deleteManagedSessionStorage,
  markSessionStorageDeletePending,
  resolveSessionStorage,
  sessionContainerArgs,
} from '../session-storage.js';
import type { AgentRuntime, AgentCapabilities, AgentEndpoint, InstanceHandle, AgentClient, HealthCheckConfig, RuntimeAccess } from '../types.js';
import type { DockerRuntimeConfig } from '../../config-loader.js';

class DockerHandle implements InstanceHandle {
  private _exitCode: number | null = null;
  private resolved = false;
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;

  constructor(
    private containerName: string,
  ) {}

  get pid(): number | undefined {
    return undefined;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  hasExited(): boolean {
    return this.resolved;
  }

  async kill(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const rm = spawn('docker', ['rm', '-f', this.containerName], { stdio: 'ignore' });
      if (rm.exitCode !== null) {
        if (rm.exitCode === 0) resolve();
        else reject(new Error(`docker rm -f exited with code ${rm.exitCode}`));
        return;
      }
      const timer = setTimeout(() => {
        reject(new Error(`Timed out removing Docker container ${this.containerName}`));
      }, 10000);
      rm.once('error', (err) => { clearTimeout(timer); reject(err); });
      rm.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`docker rm -f exited with code ${code ?? 'unknown'}`));
      });
    });
  }

  async waitForExit(timeoutMs: number): Promise<void> {
    if (this.resolved) return;
    if (!this.exitPromise) return;
    await Promise.race([
      this.exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  onExit(callback: (code: number | null) => void): void {
    if (this.resolved) return;

    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });

    const proc = spawn('docker', ['wait', this.containerName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    const finish = () => {
      if (this.resolved) return;
      this.resolved = true;
      const trimmed = output.trim();
      if (!trimmed) {
        this._exitCode = null;
      } else {
        const n = Number(trimmed);
        this._exitCode = isNaN(n) ? null : n;
      }
      this.resolveExit?.();
      callback(this._exitCode);
    };

    proc.on('exit', finish);
    proc.on('error', finish);
  }
}

export class DockerRuntime implements AgentRuntime {
  readonly type = 'opencode';
  readonly capabilities: AgentCapabilities = {
    sessions: true,
    streaming: true,
    files: true,
    tools: true,
    config: true,
    agents: true,
    skills: true,
  };

  private portPool: PortPool;
  private config: DockerRuntimeConfig;
  private containerNames = new Map<string, string>();
  private instanceAuth = new Map<string, { baseUrl: string; auth: { username: string; password: string } }>();
  private clients = new Map<string, AgentClient>();
  private ports = new Map<string, number>();
  private pendingPersistentDataDeletes = new Map<string, string>();

  constructor(portPool: PortPool, config: DockerRuntimeConfig) {
    this.portPool = portPool;
    this.config = { instanceHost: '127.0.0.1', ...config };
  }

  async start(
    id: string,
    workspacePath: string,
    auth: { username: string; password: string },
    healthCheckConfig: HealthCheckConfig,
    runtimeAccess?: RuntimeAccess,
  ): Promise<AgentEndpoint> {
    const vol = runtimeAccess?.type === 'docker' ? runtimeAccess : undefined;
    const port = await this.portPool.allocate();
    if (port === null) {
      throw new Error('No available ports in pool');
    }

    try {
      const baseUrl = `http://${this.config.instanceHost}:${port}`;
      const client = new OpenCodeAgentClient(baseUrl, auth.username, auth.password);

      const containerName = `agentorchestrator-${id}`;
      this.containerNames.set(id, containerName);

      const dockerArgs: string[] = ['run', '-d', '--name', containerName];
      appendContainerIdentityArgs(dockerArgs, this.config);
      if (this.config.logging?.driver) {
        dockerArgs.push('--log-driver', this.config.logging.driver);
      }
      if (this.config.logging?.maxSize) {
        dockerArgs.push('--log-opt', `max-size=${this.config.logging.maxSize}`);
      }
      if (this.config.logging?.maxFiles !== undefined) {
        dockerArgs.push('--log-opt', `max-file=${this.config.logging.maxFiles}`);
      }
      if (this.config.networkMode === 'host') {
        dockerArgs.push('--network', 'host');
      } else {
        dockerArgs.push('-p', `${this.config.instanceHost}:${port}:${port}`);
        if (this.config.networkMode) {
          dockerArgs.push('--network', this.config.networkMode);
        }
      }
      // Persist opencode sessions across container recreation when configured.
      // Skipped with docker-volume access (storage owned by the data container).
      const sessionMountArgs: string[] =
        !vol && this.config.sessionStorage
          ? sessionContainerArgs(resolveSessionStorage(
            this.config.sessionStorage,
            id,
            this.config.cleanupOwnerId,
          ))
          : [];
      dockerArgs.push(
        ...(vol ? ['--volumes-from', vol.container] : ['-v', `${workspacePath}:/workspace`]),
        ...sessionMountArgs,
        '-w', '/workspace',
        '-e', `OPENCODE_SERVER_USERNAME=${auth.username}`,
        '-e', `OPENCODE_SERVER_PASSWORD=${auth.password}`,
        this.config.image,
        'serve', '--port', String(port), '--hostname', '0.0.0.0',
      );

      logger.info(`Spawning OpenCode container ${containerName} on port ${port} (image: ${this.config.image})`);
      const proc = spawn('docker', dockerArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });

      proc.stdout?.on('data', (data: Buffer) => {
        logger.info(`[Docker ${id}] ${data.toString().trim()}`);
      });
      proc.stderr?.on('data', (data: Buffer) => {
        logger.warn(`[Docker ${id}] ${data.toString().trim()}`);
      });

      await this.waitForExit(proc, 30000);
      await waitForHealthy(id, baseUrl, auth, healthCheckConfig);

      this.instanceAuth.set(id, { baseUrl, auth });
      this.clients.set(id, client);
      this.ports.set(id, port);
      const handle = new DockerHandle(containerName);
      return { client, port, handle, baseUrl };
    } catch (err) {
      this.portPool.release(port);
      throw err;
    }
  }

  async stop(handle?: InstanceHandle): Promise<void> {
    if (handle) {
      await handle.kill();
    }
  }

  /** Mark the current generation before an explicit conversation delete stops it. */
  async preparePersistentDataDeletion(id: string): Promise<void> {
    if (!this.config.sessionStorage) return;
    const artifactId = markSessionStorageDeletePending(
      this.config.sessionStorage,
      id,
      this.config.cleanupOwnerId ?? DEFAULT_SESSION_CLEANUP_OWNER,
    );
    if (artifactId) this.pendingPersistentDataDeletes.set(id, artifactId);
  }

  /** Quarantine and purge only the generation marked by the explicit delete. */
  async deletePersistentData(id: string): Promise<void> {
    if (!this.config.sessionStorage) return;
    const expectedArtifactId = this.pendingPersistentDataDeletes.get(id);
    if (!expectedArtifactId) return;
    try {
      await deleteManagedSessionStorage(
        this.config.sessionStorage,
        id,
        this.config.cleanupOwnerId ?? DEFAULT_SESSION_CLEANUP_OWNER,
        expectedArtifactId,
      );
      this.pendingPersistentDataDeletes.delete(id);
    } catch (err) {
      logger.warn(`Persistent session cleanup remains pending for ${id}`);
      throw err;
    }
  }

  async restart(id: string, healthCheckConfig: HealthCheckConfig): Promise<AgentEndpoint> {
    const containerName = `agentorchestrator-${id}`;
    logger.info(`Restarting container ${containerName}...`);

    const restart = spawn('docker', ['restart', containerName], { stdio: 'ignore' });
    await this.waitForExit(restart, 10000);
    if (restart.exitCode !== 0) {
      throw new Error(`docker restart failed for container ${containerName}`);
    }

    const stored = this.instanceAuth.get(id);
    if (!stored) {
      throw new Error(`No stored connection info for instance ${id}`);
    }
    await waitForHealthy(id, stored.baseUrl, stored.auth, healthCheckConfig);

    const client = this.clients.get(id);
    const port = this.ports.get(id);
    if (!client || port === undefined) {
      throw new Error(`No stored client info for instance ${id}`);
    }
    const handle = new DockerHandle(containerName);
    return { client, port, handle, baseUrl: stored.baseUrl };
  }

  async cleanupOrphans(): Promise<void> {
    return new Promise<void>((resolve) => {
      const ps = spawn('docker', ['ps', '-a', '--filter', 'name=agentorchestrator-', '--format', '{{.Names}}'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let output = '';
      ps.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });

      ps.on('error', () => {
        resolve();
      });

      ps.on('exit', () => {
        const names = output.trim().split('\n').filter(Boolean);
        if (names.length === 0) {
          resolve();
          return;
        }

        let completed = 0;
        for (const name of names) {
          const rm = spawn('docker', ['rm', '-f', name], { stdio: 'ignore' });
          rm.on('error', () => { completed++; if (completed === names.length) resolve(); });
          rm.on('exit', () => { completed++; if (completed === names.length) resolve(); });
        }
      });
    });
  }

  private async waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
    if (proc.exitCode !== null || proc.killed) return;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

}

function appendContainerIdentityArgs(args: string[], config: DockerRuntimeConfig): void {
  if (config.containerUser) {
    args.push('--user', config.containerUser);
  }
  if (config.containerUser || config.containerHome) {
    args.push('-e', `HOME=${config.containerHome ?? '/tmp/agentorchestrator-home'}`);
  }
}
