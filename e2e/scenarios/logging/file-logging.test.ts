import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const children = new Set<ChildProcess>();
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  await Promise.all([...children].map(child => waitForExit(child, 5_000).catch(() => undefined)));
  children.clear();
  await Promise.all([...temporaryDirectories].map(directory =>
    rm(directory, { recursive: true, force: true }).catch(() => undefined),
  ));
  temporaryDirectories.clear();
});

describe('process file logging', () => {
  it('keeps console output while producing rotated, valid JSONL records', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ao-file-log-e2e-'));
    temporaryDirectories.add(temporaryDirectory);
    const logDirectory = join(temporaryDirectory, 'logs');
    const workspaceDirectory = join(temporaryDirectory, 'workspace');
    const configPath = join(temporaryDirectory, 'agentorchestrator.json');
    await writeFile(configPath, JSON.stringify({
      server: { port: 0, host: '127.0.0.1', shutdownTimeoutMs: 5_000 },
      websocket: { heartbeatIntervalMs: 30_000, idleTimeoutMs: 600_000 },
      logging: {
        file: {
          enabled: true,
          directory: logDirectory,
          maxFileSizeBytes: 256,
          maxRotatedFiles: 50,
          retentionMs: 86_400_000,
        },
      },
      cleanup: {
        ownerId: null,
        sweepIntervalMs: 60_000,
        orphanedData: { enabled: false, gracePeriodMs: 86_400_000 },
      },
      orchestrator: {
        maxInstances: 1,
        idleTimeoutMs: 0,
        idleSweepIntervalMs: 60_000,
        portRange: { start: 39_000, end: 39_001, allowDynamicFallback: true },
        defaultAgentType: 'opencode-direct',
        runtimes: [{
          id: 'opencode-direct',
          type: 'direct',
          config: { binary: 'opencode', version: '1.17.8' },
        }],
        healthCheck: { retries: 1, intervalMs: 10, clientTimeoutMs: 100 },
        sse: { enabled: false, reconnectMaxAttempts: 1, reconnectBaseMs: 10, filterHeartbeat: true },
      },
      workspace: {
        basePath: workspaceDirectory,
        enforceCanonicalConfig: false,
        maxSizeBytes: 0,
        storage: { type: 'local' },
      },
      cluster: { enabled: false, namespace: 'ao-instances', heartbeatIntervalMs: 0, quotaFailureThreshold: 2 },
    }), 'utf8');

    const cleanEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('AGENTORCHESTRATOR_')),
    );
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve('src/index.ts'), '--config', configPath],
      {
        cwd: process.cwd(),
        env: { ...cleanEnvironment, LOG_LEVEL: 'info', LOG_FORMAT: 'text' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.add(child);

    let consoleOutput = '';
    child.stdout?.on('data', chunk => { consoleOutput += chunk.toString(); });
    child.stderr?.on('data', chunk => { consoleOutput += chunk.toString(); });

    await waitFor(
      'server startup console log',
      () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Server exited before startup (${child.exitCode ?? child.signalCode}): ${consoleOutput}`);
        }
        return consoleOutput.includes('AgentOrchestrator listening on http://127.0.0.1:');
      },
      20_000,
    );
    await waitFor('mirrored startup JSONL record', async () => {
      const records = await readLogRecords(logDirectory);
      return records.some(record =>
        typeof record.message === 'string'
        && record.message.startsWith('RBAC:'),
      );
    }, 10_000);

    const files = await readdir(logDirectory);
    expect(files).toContain('agentorchestrator.jsonl');
    expect(files.some(name => /^agentorchestrator\..+\.jsonl$/.test(name))).toBe(true);

    const records = await readLogRecords(logDirectory);
    expect(records.length).toBeGreaterThan(0);
    expect(records.every(record =>
      typeof record.timestamp === 'string'
      && typeof record.level === 'string'
      && typeof record.message === 'string'
    )).toBe(true);
    expect(consoleOutput).toContain('AgentOrchestrator starting...');
    expect(records.some(record => record.message === 'AgentOrchestrator starting...')).toBe(true);

    child.kill('SIGTERM');
    await waitForExit(child, 10_000);
    children.delete(child);
  });
});

async function readLogRecords(directory: string): Promise<Array<Record<string, unknown>>> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const records: Array<Record<string, unknown>> = [];
  for (const name of names.filter(entry => entry.endsWith('.jsonl')).sort()) {
    let content: string;
    try {
      content = await readFile(join(directory, name), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
      try {
        records.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        return [];
      }
    }
  }
  return records;
}

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error('Child process did not exit in time')), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}
