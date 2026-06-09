import { spawn } from 'cross-spawn';
import { logger } from '../utils/logger.js';
import type { Runtime } from '../config-loader.js';

export interface ModelEntry {
  id: string;
  provider: string;
  model: string;
}

export interface ListModelsOptions {
  runtime: Runtime;
  opencodeBinary: string;
  dockerImage?: string;
}

const MODELS_TIMEOUT_MS = 10000;

function parseModelsOutput(stdout: string): ModelEntry[] {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const entries: ModelEntry[] = [];
  for (const line of lines) {
    const parts = line.split('/');
    if (parts.length >= 2) {
      const provider = parts[0];
      const model = parts.slice(1).join('/');
      entries.push({
        id: line,
        provider,
        model,
      });
    }
  }
  return entries;
}

export async function listModels(options: ListModelsOptions): Promise<ModelEntry[]> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: ModelEntry[]) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => {
      logger.warn('opencode models timed out');
      proc.kill();
      settle([]);
    }, MODELS_TIMEOUT_MS);

    let command: string;
    let args: string[];

    if (options.runtime === 'docker') {
      command = 'docker';
      args = ['run', '--rm', options.dockerImage!, 'models'];
    } else {
      command = options.opencodeBinary;
      args = ['models'];
    }

    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger.warn(`opencode models exited with code ${code}: ${stderr.trim()}`);
        settle([]);
        return;
      }

      settle(parseModelsOutput(stdout));
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      logger.error('Failed to spawn opencode models:', err.message);
      settle([]);
    });
  });
}
