import { type ChildProcess, spawn } from 'cross-spawn';
import treeKill from 'tree-kill';
import { logger } from '../../utils/logger.js';
import { OpenCodeAgentClient } from '../../opencode-http/client.js';
import type { AgentRuntime, AgentCapabilities, SpawnResult } from '../types.js';

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

  constructor(
    private opencodeBinary: string,
    private runtime: 'direct' | 'docker',
    private dockerConfig?: { image: string; containerPort: number },
  ) {}

  async spawn(
    id: string,
    port: number,
    workspacePath: string,
    auth: { username: string; password: string },
    healthCheckConfig: { retries: number; intervalMs: number; clientTimeoutMs: number },
  ): Promise<SpawnResult> {
    const baseUrl = `http://127.0.0.1:${port}`;
    const client = new OpenCodeAgentClient(baseUrl, auth.username, auth.password);

    let proc: ChildProcess;
    if (this.runtime === 'docker') {
      proc = this.spawnDocker(id, port, workspacePath, auth);
    } else {
      proc = this.spawnDirect(id, port, workspacePath, auth);
    }

    // Health check with dedicated short-timeout client
    const healthClient = new OpenCodeAgentClient(baseUrl, auth.username, auth.password, healthCheckConfig.clientTimeoutMs);
    let healthy = false;
    for (let i = 0; i < healthCheckConfig.retries; i++) {
      await this.delay(healthCheckConfig.intervalMs);
      try {
        const result = await healthClient.health();
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
      await this.kill(proc);
      throw new Error(`OpenCode instance failed health check after ${healthCheckConfig.retries} retries`);
    }

    return { process: proc, client };
  }

  async kill(process: ChildProcess, signal?: string | number): Promise<void> {
    if (process.killed || process.exitCode !== null || process.pid === undefined) return;
    return new Promise<void>((resolve) => {
      treeKill(process.pid!, signal, (err) => {
        if (err) {
          logger.warn(`kill error for PID ${process.pid}: ${err.message}`);
        }
        resolve();
      });
    });
  }

  private spawnDirect(id: string, port: number, workspacePath: string, auth: { username: string; password: string }): ChildProcess {
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

    return proc;
  }

  private spawnDocker(id: string, port: number, workspacePath: string, auth: { username: string; password: string }): ChildProcess {
    const { image, containerPort } = this.dockerConfig!;
    const containerName = `agentorchestrator-${id}`;

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

    return proc;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
