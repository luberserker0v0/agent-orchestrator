import { spawn } from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import treeKill from 'tree-kill';
import { logger } from '../../utils/logger.js';
import { OpenCodeAgentClient } from '../../opencode-http/client.js';
import { PortPool } from '../../orchestrator/port-pool.js';
import { waitForHealthy } from '../health.js';
import type { AgentRuntime, AgentCapabilities, SpawnResult, InstanceHandle, HealthCheckConfig } from '../types.js';
import type { DirectRuntimeConfig } from '../../config-loader.js';

class ChildProcessHandle implements InstanceHandle {
  constructor(private proc: ChildProcess) {}

  get pid(): number | undefined {
    return this.proc.pid;
  }

  get exitCode(): number | null {
    return this.proc.exitCode;
  }

  kill(signal?: string): Promise<void> {
    if (!this.proc || this.proc.killed || this.proc.exitCode !== null || this.proc.pid === undefined) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      treeKill(this.proc.pid!, signal ?? 'SIGTERM', (err) => {
        if (err) {
          logger.warn(`kill error for PID ${this.proc.pid}: ${err.message}`);
        }
        resolve();
      });
    });
  }

  waitForExit(timeoutMs: number): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.killed) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  onExit(callback: (code: number | null) => void): void {
    this.proc.on('exit', callback);
  }
}

export class DirectRuntime implements AgentRuntime {
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
  private config: DirectRuntimeConfig & { instanceHost: string };

  constructor(portPool: PortPool, config?: DirectRuntimeConfig) {
    this.portPool = portPool;
    this.config = { binary: config?.binary ?? 'opencode', instanceHost: config?.instanceHost ?? '127.0.0.1' };
  }

  async spawn(
    id: string,
    workspacePath: string,
    auth: { username: string; password: string },
    healthCheckConfig: HealthCheckConfig,
  ): Promise<SpawnResult> {
    const port = await this.portPool.allocate();
    if (port === null) {
      throw new Error('No available ports in pool');
    }

    const baseUrl = `http://${this.config.instanceHost}:${port}`;
    const client = new OpenCodeAgentClient(baseUrl, auth.username, auth.password);

    logger.info(`Spawning OpenCode instance on port ${port} at ${workspacePath} (binary: ${this.config.binary})`);
    const proc = spawn(this.config.binary, ['serve', '--port', String(port), '--hostname', this.config.instanceHost], {
      cwd: workspacePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        OPENCODE_SERVER_USERNAME: auth.username,
        OPENCODE_SERVER_PASSWORD: auth.password,
      },
    });

    proc.stdout?.on('data', (data: Buffer) => {
      logger.info(`[OpenCode ${id}] stdout: ${data.toString().trim()}`);
    });
    proc.stderr?.on('data', (data: Buffer) => {
      logger.warn(`[OpenCode ${id}] stderr: ${data.toString().trim()}`);
    });

    await waitForHealthy(id, baseUrl, auth, healthCheckConfig);

    const handle = new ChildProcessHandle(proc);
    return { client, port, handle };
  }

  async kill(handle?: InstanceHandle): Promise<void> {
    if (handle) {
      await handle.kill();
    }
  }


}
