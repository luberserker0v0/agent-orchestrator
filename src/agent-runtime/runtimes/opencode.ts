import { spawn } from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import treeKill from 'tree-kill';
import { logger } from '../../utils/logger.js';
import { OpenCodeAgentClient } from '../../opencode-http/client.js';
import type { AgentRuntime, AgentCapabilities, SpawnResult, AgentClient } from '../types.js';

export class OpenCodeRuntime implements AgentRuntime {
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

  private containerNames = new Map<string, string>();

  constructor(
    private runtime: string,
    private runtimeConfig: Record<string, unknown>,
  ) {
    this.opencodeBinary = (runtimeConfig.binary as string) ?? 'opencode';
    if (runtime === 'docker') {
      this.dockerConfig = runtimeConfig.docker as { image: string; containerPort: number } | undefined;
    }
  }

  private opencodeBinary: string;
  private dockerConfig?: { image: string; containerPort: number };

  async spawn(
    id: string,
    port: number,
    workspacePath: string,
    auth: { username: string; password: string },
    healthCheckConfig: { retries: number; intervalMs: number; clientTimeoutMs: number },
  ): Promise<SpawnResult> {
    const baseUrl = `http://127.0.0.1:${port}`;
    const client = new OpenCodeAgentClient(baseUrl, auth.username, auth.password);

    if (this.runtime === 'docker') {
      return this.spawnDocker(id, port, workspacePath, auth, client, baseUrl, healthCheckConfig);
    }
    return this.spawnDirect(id, port, workspacePath, auth, client, baseUrl, healthCheckConfig);
  }

  async kill(process?: ChildProcess, signal?: string | number): Promise<void> {
    if (!process || process.killed || process.exitCode !== null || process.pid === undefined) return;
    return new Promise<void>((resolve) => {
      treeKill(process.pid!, signal, (err) => {
        if (err) {
          logger.warn(`kill error for PID ${process.pid}: ${err.message}`);
        }
        resolve();
      });
    });
  }

  async cleanupOrphans(): Promise<void> {
    if (this.runtime !== 'docker') {
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

  async restart(id: string, client: AgentClient): Promise<void> {
    if (this.runtime !== 'docker') {
      throw new Error('restartInstance is only supported for Docker runtime');
    }

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

  private async spawnDirect(
    id: string, port: number, workspacePath: string,
    auth: { username: string; password: string },
    client: OpenCodeAgentClient, baseUrl: string,
    healthCheckConfig: { retries: number; intervalMs: number; clientTimeoutMs: number },
  ): Promise<SpawnResult> {
    logger.info(`Spawning OpenCode instance on port ${port} at ${workspacePath} (binary: ${this.opencodeBinary})`);
    const proc = spawn(this.opencodeBinary, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
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

    await this.waitForHealthy(id, baseUrl, auth, healthCheckConfig);
    return { process: proc, client };
  }

  private async spawnDocker(
    id: string, port: number, workspacePath: string,
    auth: { username: string; password: string },
    client: OpenCodeAgentClient, baseUrl: string,
    healthCheckConfig: { retries: number; intervalMs: number; clientTimeoutMs: number },
  ): Promise<SpawnResult> {
    const { image, containerPort } = this.dockerConfig!;
    const containerName = `agentorchestrator-${id}`;
    this.containerNames.set(id, containerName);

    logger.info(`Spawning OpenCode container ${containerName} on port ${port} (image: ${image})`);
    const proc = spawn('docker', [
      'run', '-d',
      '--name', containerName,
      '-p', `127.0.0.1:${port}:${containerPort}`,
      '-v', `${workspacePath}:/workspace`,
      '-w', '/workspace',
      '-e', `OPENCODE_SERVER_USERNAME=${auth.username}`,
      '-e', `OPENCODE_SERVER_PASSWORD=${auth.password}`,
      image,
      'serve', '--port', String(containerPort), '--hostname', '0.0.0.0',
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

    const dispose = async () => {
      const rm = spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
      await this.waitForExit(rm, 10000);
      this.containerNames.delete(id);
    };

    return { process: undefined, client, dispose };
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
