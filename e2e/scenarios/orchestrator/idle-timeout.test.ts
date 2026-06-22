import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, type E2EServer } from '../../helpers/server.js';
import { OPENCODE_CONFIG } from '../../../src/test-fixtures/user-configs.js';
import { uploadOpencodeConfig } from '../../../src/test-fixtures/helpers.js';

describe('Idle timeout → auto-destroy → recovery (E2E)', () => {
  let server: E2EServer;
  const convId = 'e2e-idle';

  beforeAll(async () => {
    server = await startServer({
      idleTimeoutMs: 5000,
      idleSweepIntervalMs: 1000,
    });
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

  async function waitForStatus(target: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(`${server.baseUrl}/api/conversations/${convId}`);
      const body = await res.json() as { status: string };
      if (body.status === target) return;
    }
    const res = await fetch(`${server.baseUrl}/api/conversations/${convId}`);
    const body = await res.json() as { status: string };
    throw new Error(`Timed out waiting for status ${target}, current: ${body.status}`);
  }

  async function sendAndVerify(): Promise<void> {
    const res = await fetch(`${server.baseUrl}/api/conversations/${convId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Say hello in one word', model: OPENCODE_CONFIG.model }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { messageId: string; text: string; parts: Array<{ type: string; text?: string }> };
    expect(body).toHaveProperty('messageId');
    expect(body.messageId).toBeTruthy();
    expect(body).toHaveProperty('text');
    expect(body.text.length).toBeGreaterThan(0);
  }

  it('creates conversation and starts', async () => {
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
    expect((await start.json()).status).toBe('running');
  });

  it('waits for ready and sends message', async () => {
    await waitForReady();
    await sendAndVerify();
  });

  it('idle timeout destroys instance → state becomes stopped', async () => {
    await waitForStatus('stopped');
  });

  it('recovers via start after idle timeout', async () => {
    const start = await fetch(`${server.baseUrl}/api/conversations/${convId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(start.status).toBe(200);
    expect((await start.json()).status).toBe('running');
  });

  it('can send message after idle recovery', async () => {
    await waitForReady();
    await sendAndVerify();
  });

  it('can stop, start again, and message after idle recovery', async () => {
    const stop = await fetch(`${server.baseUrl}/api/conversations/${convId}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(stop.status).toBe(200);
    expect((await stop.json()).status).toBe('stopped');

    const start = await fetch(`${server.baseUrl}/api/conversations/${convId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(start.status).toBe(200);
    expect((await start.json()).status).toBe('running');

    await waitForReady();
    await sendAndVerify();
  });

  it('deletes conversation and cleans up workspace', async () => {
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
