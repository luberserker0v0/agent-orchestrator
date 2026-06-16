import { spawn } from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { logger } from '../../utils/logger.js';
import { OpenCodeAgentClient } from '../../opencode-http/client.js';
import { PortPool } from '../../orchestrator/port-pool.js';
import type { AgentRuntime, AgentCapabilities, SpawnResult, InstanceHandle, AgentClient } from '../types.js';
import type { DockerRuntimeConfig } from '../../config-loader.js';

class DockerHandle implements InstanceHandle {
  constructor(
    private containerName: string,
  ) {}

  get pid(): number | undefined {
    return undefined;
  }

  get exitCode(): number | null {
    return null;
  }

  async kill(): Promise<void> {
    return new Promise<void>((resolve) => {
      const rm = spawn('docker', ['rm', '-f', this.containerName], { stdio: 'ignore' });
      if (rm.exitCode !== null || rm.killed) {
        resolve();
        return;
      }
      const timer = setTimeout(() => resolve(), 10000);
      rm.on('error', () => { clearTimeout(timer); resolve(); });
      rm.on('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  async waitForExit(_timeoutMs: number): Promise<void> {
    // Docker container has no associated child process; treat as always alive
  }

  onExit(_callback: (code: number | null) => void): void {
    // No child process to monitor for Docker
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

  constructor(portPool: PortPool, config: DockerRuntimeConfig) {
    this.portPool = portPool;
    this.config = config;
  }

  async spawn(
    id: string,
    workspacePath: string,
    auth: { username: string; password: string },
    healthCheckConfig: { retries: number; intervalMs: number; clientTimeoutMs: number },
  ): Promise<SpawnResult> {
    const port = await this.portPool.allocate();
    if (port === null) {
      throw new Error('No available ports in pool');
    }

    const baseUrl = `http://127.0.0.1:${port}`;
    const client = new OpenCodeAgentClient(baseUrl, auth.username, auth.password);

    const containerName = `agentorchestrator-${id}`;
    this.containerNames.set(id, containerName);

    logger.info(`Spawning OpenCode container ${containerName} on port ${port} (image: ${this.config.image})`);
    const proc = spawn('docker', [
      'run', '-d',
      '--name', containerName,
      '-p', `127.0.0.1:${port}:${this.config.containerPort}`,
      '-v', `${workspacePath}:/workspace`,
      '-w', '/workspace',
      '-e', `OPENCODE_SERVER_USERNAME=${auth.username}`,
      '-e', `OPENCODE_SERVER_PASSWORD=${auth.password}`,
      this.config.image,
      'serve', '--port', String(this.config.containerPort), '--hostname', '0.0.0.0',
    ], {
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
    await this.waitForHealthy(id, baseUrl, auth, healthCheckConfig);

    const handle = new DockerHandle(containerName);
    return { client, port, handle };
  }

  async kill(handle?: InstanceHandle): Promise<void> {
    if (handle) {
      await handle.kill();
    }
  }

  async restart(id: string, client: AgentClient): Promise<void> {
    const containerName = `agentorchestrator-${id}`;
    logger.info(`Restarting container ${containerName}...`);

    const restart = spawn('docker', ['restart', containerName], { stdio: 'ignore' });
    await this.waitForExit(restart, 10000);
    if (restart.exitCode !== 0) {
      throw new Error(`docker restart failed for container ${containerName}`);
    }

    // Health check after restart
    let healthy = false;
    for (let i = 0; i < 10; i++) {
      await this.delay(500);
      try {
        const result = await client.health();
        if (result.healthy) {
          healthy = true;
          break;
        }
      } catch {
        // retry
      }
    }

    if (!healthy) {
      throw new Error(`Container restart health check failed for ${id}`);
    }
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

  private async waitForHealthy(
    id: string, baseUrl: string,
    auth: { username: string; password: string },
    healthCheckConfig: { retries: number; intervalMs: number; clientTimeoutMs: number },
  ): Promise<void> {
    const healthClient = new OpenCodeAgentClient(baseUrl, auth.username, auth.password, healthCheckConfig.clientTimeoutMs);
    for (let i = 0; i < healthCheckConfig.retries; i++) {
      await this.delay(healthCheckConfig.intervalMs);
      try {
        const result = await healthClient.health();
        if (result.healthy) {
          logger.info(`[OpenCode ${id}] health check passed (version ${result.version})`);
          return;
        }
      } catch (err) {
        logger.warn(`[OpenCode ${id}] health check attempt ${i + 1} failed: ${(err as Error).message}`);
      }
    }
    throw new Error(`OpenCode instance failed health check after ${healthCheckConfig.retries} retries`);
  }

  private async waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
    if (proc.exitCode !== null || proc.killed) return;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
