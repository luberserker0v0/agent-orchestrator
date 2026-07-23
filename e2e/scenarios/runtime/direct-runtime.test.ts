import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, type E2EServer } from '../../helpers/server.js';
import { OPENCODE_CONFIG } from '../../../src/test-fixtures/user-configs.js';
import { uploadOpencodeConfig } from '../../../src/test-fixtures/helpers.js';

const hasOpencode = spawnSync('opencode', ['--version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!hasOpencode)('DirectRuntime — process lifecycle (E2E)', () => {
  let server: E2EServer;
  const convId = 'e2e-direct-runtime';

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

  it('creates conversation and starts with opencode binary', async () => {
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

  it('process is healthy and ready', async () => {
    const sessionId = await waitForReady();
    expect(sessionId).toBeTruthy();
  });

  it('sends message through spawned process', async () => {
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

  it('graceful stop sends SIGTERM and cleans up process', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/${convId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('stopped');

    const detail = await fetch(`${server.baseUrl}/api/conversations/${convId}`);
    const body = await detail.json() as { port?: number };
    expect(body.port).toBeUndefined();
  });

  it('restart spawns new process on fresh port', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/${convId}/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('running');
    expect(typeof body.port).toBe('number');
  });

  it('new process is healthy after restart', async () => {
    await waitForReady();
  });

  it('delete kills process and removes workspace', async () => {
    const wsPath = join(server.workspaceDir, convId);
    expect(existsSync(wsPath)).toBe(true);

    const del = await fetch(`${server.baseUrl}/api/conversations/${convId}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    for (let i = 0; i < 30; i++) {
      if (!existsSync(wsPath)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(existsSync(wsPath)).toBe(false);
  });
});
