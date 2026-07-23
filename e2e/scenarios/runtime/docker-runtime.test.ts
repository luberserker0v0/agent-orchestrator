import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, type E2EServer } from '../../helpers/server.js';
import { OPENCODE_CONFIG } from '../../../src/test-fixtures/user-configs.js';
import { uploadOpencodeConfig } from '../../../src/test-fixtures/helpers.js';
import { TEST_DOCKER_IMAGE } from '../../../src/test-fixtures/ao-configs.js';

const dockerAvailable =
  spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('docker', ['inspect', TEST_DOCKER_IMAGE], { stdio: 'ignore' }).status === 0;

function dockerPs(filter: string): string[] {
  const result = spawnSync('docker', [
    'ps', '-a', '--filter', filter, '--format', '{{.Names}}',
  ], { encoding: 'utf-8', timeout: 5000 });
  return result.stdout.trim().split('\n').filter(Boolean);
}

function dockerInspect(name: string): Record<string, unknown> | null {
  const result = spawnSync('docker', [
    'inspect', name,
  ], { encoding: 'utf-8', timeout: 5000 });
  if (result.status !== 0) return null;
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

describe.skipIf(!dockerAvailable)('DockerRuntime — container lifecycle (E2E)', () => {
  let server: E2EServer;
  const convId = 'e2e-docker-runtime';

  beforeAll(async () => {
    server = await startServer();
  }, 30_000);

  afterAll(async () => {
    try { await fetch(`${server.baseUrl}/api/conversations/${convId}`, { method: 'DELETE' }); } catch { /* ignore */ }
    await server.cleanup();
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
    const ports = (inspect as any).NetworkSettings?.Ports ?? {};
    const portKey = `${body.port}/tcp`;
    expect(ports[portKey]).toBeDefined();
    expect(ports[portKey].length).toBeGreaterThan(0);
  });

  it('container has auth env vars', async () => {
    const inspect = dockerInspect('agentorchestrator-e2e-docker-runtime');
    expect(inspect).not.toBeNull();
    const env: string[] = (inspect as any).Config?.Env ?? [];
    expect(env.some((e: string) => e.startsWith('OPENCODE_SERVER_USERNAME='))).toBe(true);
    expect(env.some((e: string) => e.startsWith('OPENCODE_SERVER_PASSWORD='))).toBe(true);
  });

  it('container is healthy and ready', async () => {
    const sessionId = await waitForReady();
    expect(sessionId).toBeTruthy();
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
    const res = await fetch(`${server.baseUrl}/api/conversations/${convId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('stopped');

    const containers = dockerPs('name=agentorchestrator-e2e-docker-runtime');
    expect(containers.length).toBe(0);
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
    await waitForReady();
  });

  it('delete removes container and workspace', async () => {
    const wsPath = join(server.workspaceDir, convId);
    expect(existsSync(wsPath)).toBe(true);

    const del = await fetch(`${server.baseUrl}/api/conversations/${convId}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    for (let i = 0; i < 30; i++) {
      if (!existsSync(wsPath)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(existsSync(wsPath)).toBe(false);

    const containers = dockerPs('name=agentorchestrator-e2e-docker-runtime');
    expect(containers.length).toBe(0);
  });
});
