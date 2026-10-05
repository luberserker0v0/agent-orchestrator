import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type E2EServer } from '../../helpers/server.js';
import { OPENCODE_CONFIG } from '../../../src/test-fixtures/user-configs.js';
import { uploadOpencodeConfig } from '../../../src/test-fixtures/helpers.js';
import { TEST_DOCKER_IMAGE } from '../../../src/test-fixtures/ao-configs.js';
import { sessionOwnershipRecordPath } from '../../../src/agent-runtime/session-storage.js';
import type { SessionStorageConfig } from '../../../src/config-loader.js';

const dockerAvailable =
  spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('docker', ['inspect', TEST_DOCKER_IMAGE], { stdio: 'ignore' }).status === 0;

function dockerPs(filter: string): string[] {
  const result = spawnSync('docker', [
    'ps', '-a', '--filter', filter, '--format', '{{.Names}}',
  ], { encoding: 'utf-8', timeout: 5000 });
  return result.stdout.trim().split('\n').filter(Boolean);
}

interface DockerInspect {
  NetworkSettings?: { Ports?: Record<string, unknown[]> };
  Config?: { Env?: string[] };
}

function dockerInspect(name: string): DockerInspect | null {
  const result = spawnSync('docker', [
    'inspect', name,
  ], { encoding: 'utf-8', timeout: 5000 });
  if (result.status !== 0) return null;
  const parsed = JSON.parse(result.stdout);
  return (Array.isArray(parsed) ? parsed[0] : parsed) as DockerInspect;
}

describe.skipIf(!dockerAvailable)('DockerRuntime — container lifecycle (E2E)', () => {
  let server: E2EServer;
  let sessionRoot: string;
  let sessionStorage: SessionStorageConfig;
  let initialSessionId: string;
  const convId = 'e2e-docker-runtime';

  beforeAll(async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'e2e-docker-sessions-'));
    sessionStorage = { sharedRoot: sessionRoot, mode: 'xdg' };
    server = await startServer({
      defaultAgentType: 'opencode-docker',
      runtimes: [{
        id: 'opencode-docker',
        type: 'docker',
        config: {
          image: TEST_DOCKER_IMAGE,
          sessionStorage,
          cleanupOwnerId: 'e2e-docker-owner',
        },
      }],
    });
  }, 30_000);

  afterAll(async () => {
    if (server) {
      try { await fetch(`${server.baseUrl}/api/conversations/${convId}`, { method: 'DELETE' }); } catch { /* ignore */ }
      await server.cleanup();
    }
    if (sessionRoot) rmSync(sessionRoot, { recursive: true, force: true });
  }, 15_000);

  async function waitForReady(): Promise<string> {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(`${server.baseUrl}/api/conversations/${convId}`);
      const body = await res.json() as { ready: boolean; sessionId?: string };
      if (body.ready === true && body.sessionId) return body.sessionId;
    }
    throw new Error('Timed out waiting for ready state');
  }

  it('creates conversation and starts docker container', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: convId }),
    });
    expect(res.status).toBe(201);

    await uploadOpencodeConfig(server.baseUrl, convId, OPENCODE_CONFIG);

    const start = await fetch(`${server.baseUrl}/api/conversations/${convId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(start.status).toBe(200);
    const body = await start.json();
    expect(body.status).toBe('running');
    expect(typeof body.port).toBe('number');
  });

  it('container is running with correct name', async () => {
    const containers = dockerPs('name=agentorchestrator-e2e-docker-runtime');
    expect(containers.length).toBe(1);
    expect(containers[0]).toBe('agentorchestrator-e2e-docker-runtime');
  });

  it('container has port mapping', async () => {
    const detail = await fetch(`${server.baseUrl}/api/conversations/${convId}`);
    const body = await detail.json() as { port: number };
    expect(typeof body.port).toBe('number');
    expect(body.port).toBeGreaterThan(0);

    const inspect = dockerInspect('agentorchestrator-e2e-docker-runtime');
    expect(inspect).not.toBeNull();
    const ports = inspect?.NetworkSettings?.Ports ?? {};
    const portKey = `${body.port}/tcp`;
    expect(ports[portKey]).toBeDefined();
    expect(ports[portKey].length).toBeGreaterThan(0);
  });

  it('container has auth env vars', async () => {
    const inspect = dockerInspect('agentorchestrator-e2e-docker-runtime');
    expect(inspect).not.toBeNull();
    const env = inspect?.Config?.Env ?? [];
    expect(env.some((e: string) => e.startsWith('OPENCODE_SERVER_USERNAME='))).toBe(true);
    expect(env.some((e: string) => e.startsWith('OPENCODE_SERVER_PASSWORD='))).toBe(true);
  });

  it('container is healthy and ready', async () => {
    initialSessionId = await waitForReady();
    expect(initialSessionId).toBeTruthy();
  });

  it('sends message through container', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/${convId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Say hello in one word', model: OPENCODE_CONFIG.model }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { messageId: string; text: string; parts: Array<{ type: string; text?: string }> };
    expect(body.messageId).toBeTruthy();
    expect(body.text.length).toBeGreaterThan(0);
  });

  it('stop removes container via docker rm -f', async () => {
    const sessionPath = join(sessionRoot, convId);
    const ownershipPath = sessionOwnershipRecordPath(sessionStorage, convId);
    expect(existsSync(sessionPath)).toBe(true);
    expect(existsSync(ownershipPath)).toBe(true);

    const res = await fetch(`${server.baseUrl}/api/conversations/${convId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('stopped');

    const containers = dockerPs('name=agentorchestrator-e2e-docker-runtime');
    expect(containers.length).toBe(0);
    expect(existsSync(sessionPath)).toBe(true);
    expect(existsSync(ownershipPath)).toBe(true);
  });

  it('restart creates new container after stop', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/${convId}/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('running');
    expect(typeof body.port).toBe('number');
    expect(body.port).toBeGreaterThan(0);

    const containers = dockerPs('name=agentorchestrator-e2e-docker-runtime');
    expect(containers.length).toBe(1);
  });

  it('new container is healthy after restart', async () => {
    expect(await waitForReady()).toBe(initialSessionId);
  });

  it('explicit delete removes the container, workspace, and persistent session data', async () => {
    const wsPath = join(server.workspaceDir, convId);
    const sessionPath = join(sessionRoot, convId);
    const ownershipPath = sessionOwnershipRecordPath(sessionStorage, convId);
    expect(existsSync(wsPath)).toBe(true);
    expect(existsSync(sessionPath)).toBe(true);
    expect(existsSync(ownershipPath)).toBe(true);

    const del = await fetch(`${server.baseUrl}/api/conversations/${convId}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    for (let i = 0; i < 30; i++) {
      if (!existsSync(wsPath)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(existsSync(wsPath)).toBe(false);
    expect(existsSync(sessionPath)).toBe(false);
    expect(existsSync(ownershipPath)).toBe(false);

    const containers = dockerPs('name=agentorchestrator-e2e-docker-runtime');
    expect(containers.length).toBe(0);
  });
});
