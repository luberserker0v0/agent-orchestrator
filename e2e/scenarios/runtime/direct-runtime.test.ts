import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type E2EServer } from '../../helpers/server.js';
import { OPENCODE_CONFIG } from '../../../src/test-fixtures/user-configs.js';
import { uploadOpencodeConfig } from '../../../src/test-fixtures/helpers.js';
import { sessionOwnershipRecordPath } from '../../../src/agent-runtime/session-storage.js';
import type { SessionStorageConfig } from '../../../src/config-loader.js';

const hasOpencode = spawnSync('opencode', ['--version'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!hasOpencode)('DirectRuntime — process lifecycle (E2E)', () => {
  let server: E2EServer;
  let sessionRoot: string;
  let sessionStorage: SessionStorageConfig;
  let initialSessionId: string;
  const convId = 'e2e-direct-runtime';

  beforeAll(async () => {
    sessionRoot = mkdtempSync(join(tmpdir(), 'e2e-direct-sessions-'));
    sessionStorage = { sharedRoot: sessionRoot, mode: 'xdg' };
    server = await startServer({
      defaultAgentType: 'opencode-direct',
      runtimes: [{
        id: 'opencode-direct',
        type: 'direct',
        config: { binary: 'opencode', sessionStorage, cleanupOwnerId: 'e2e-direct-owner' },
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
    initialSessionId = await waitForReady();
    expect(initialSessionId).toBeTruthy();
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

    const detail = await fetch(`${server.baseUrl}/api/conversations/${convId}`);
    const body = await detail.json() as { port?: number };
    expect(body.port).toBeUndefined();
    expect(existsSync(sessionPath)).toBe(true);
    expect(existsSync(ownershipPath)).toBe(true);
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
    expect(await waitForReady()).toBe(initialSessionId);
  });

  it('explicit delete kills the process and removes workspace and persistent session data', async () => {
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
  });
});
