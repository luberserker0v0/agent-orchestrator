import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, type E2EServer } from '../../helpers/server.js';
import { OPENCODE_CONFIG } from '../../../src/test-fixtures/user-configs.js';
import { uploadOpencodeConfig } from '../../../src/test-fixtures/helpers.js';

describe('Max instances / LRU eviction (E2E)', () => {
  let server: E2EServer;

  beforeAll(async () => {
    server = await startServer({ maxInstances: 2 });
  }, 30_000);

  afterAll(async () => {
    for (const id of ['e2e-lim-1', 'e2e-lim-2', 'e2e-lim-3']) {
      try { await fetch(`${server.baseUrl}/api/conversations/${id}`, { method: 'DELETE' }); } catch { /* ignore */ }
    }
    await server.cleanup();
  }, 15_000);

  async function waitForReady(convId: string): Promise<string> {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(`${server.baseUrl}/api/conversations/${convId}`);
      const body = await res.json() as { ready: boolean; sessionId?: string };
      if (body.ready === true && body.sessionId) return body.sessionId;
    }
    throw new Error(`Timed out waiting for ready on ${convId}`);
  }

  async function waitForStatus(convId: string, target: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(`${server.baseUrl}/api/conversations/${convId}`);
      const body = await res.json() as { status: string };
      if (body.status === target) return;
    }
    const res = await fetch(`${server.baseUrl}/api/conversations/${convId}`);
    const body = await res.json() as { status: string };
    throw new Error(`Timed out waiting for ${convId} status ${target}, current: ${body.status}`);
  }

  async function sendAndVerify(convId: string): Promise<void> {
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

  it('creates three conversations', async () => {
    for (const id of ['e2e-lim-1', 'e2e-lim-2', 'e2e-lim-3']) {
      const res = await fetch(`${server.baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      expect(res.status).toBe(201);
    }
  });

  it('uploads config to all conversations', async () => {
    for (const id of ['e2e-lim-1', 'e2e-lim-2', 'e2e-lim-3']) {
      await uploadOpencodeConfig(server.baseUrl, id, OPENCODE_CONFIG);
    }
  });

  it('starts conv1 and conv2 — both become running', async () => {
    for (const id of ['e2e-lim-1', 'e2e-lim-2']) {
      const res = await fetch(`${server.baseUrl}/api/conversations/${id}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe('running');
    }
  });

  it('both can send messages before eviction', async () => {
    for (const id of ['e2e-lim-1', 'e2e-lim-2']) {
      await waitForReady(id);
      await sendAndVerify(id);
    }
  });

  it('start conv3 → LRU evicts conv1, conv3 becomes running', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-lim-3/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('running');
  });

  it('conv1 is stopped (LRU evicted), conv2+conv3 remain running', async () => {
    await waitForStatus('e2e-lim-1', 'stopped');

    for (const id of ['e2e-lim-2', 'e2e-lim-3']) {
      const res = await fetch(`${server.baseUrl}/api/conversations/${id}`);
      expect((await res.json()).status).toBe('running');
    }
  });

  it('conv3 can send messages', async () => {
    await waitForReady('e2e-lim-3');
    await sendAndVerify('e2e-lim-3');
  });

  it('recovers conv1 via start and can send messages', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-lim-1/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('running');

    await waitForReady('e2e-lim-1');
    await sendAndVerify('e2e-lim-1');
  });

  it('deletes all conversations and cleans up workspace', async () => {
    for (const id of ['e2e-lim-1', 'e2e-lim-2', 'e2e-lim-3']) {
      const wsPath = join(server.workspaceDir, id);
      expect(existsSync(wsPath)).toBe(true);

      const del = await fetch(`${server.baseUrl}/api/conversations/${id}`, { method: 'DELETE' });
      expect(del.status).toBe(204);

      for (let i = 0; i < 30; i++) {
        if (!existsSync(wsPath)) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      expect(existsSync(wsPath)).toBe(false);
    }
  });
});
