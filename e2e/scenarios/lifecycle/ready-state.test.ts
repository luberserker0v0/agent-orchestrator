import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type E2EServer } from '../../helpers/server.js';
import { createWSClient } from '../../helpers/ws.js';
import { createProviderConfig } from '../../../src/test-fixtures/user-configs.js';
import { uploadOpencodeConfig } from '../../../src/test-fixtures/helpers.js';

describe('Ready State (E2E)', () => {
  let server: E2EServer;

  beforeAll(async () => {
    server = await startServer();
  }, 30_000);

  afterAll(async () => {
    await server.cleanup();
  }, 15_000);

  async function waitForReady(baseUrl: string, conversationId: string): Promise<void> {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const res = await fetch(`${baseUrl}/api/conversations/${conversationId}`);
      const body = await res.json() as { ready: boolean };
      if (body.ready === true) return;
    }
    throw new Error('Timed out waiting for ready state');
  }

  it('transitions to ready after start', async () => {
    await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-ready' }),
    });

    await uploadOpencodeConfig(server.baseUrl, 'e2e-ready', createProviderConfig());

    const startRes = await fetch(`${server.baseUrl}/api/conversations/e2e-ready/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(startRes.status).toBe(200);
    expect((await startRes.json()).ready).toBe(false);

    await waitForReady(server.baseUrl, 'e2e-ready');
  });

  it('sends message via WebSocket after ready', async () => {
    const conv = await (await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-ready-ws' }),
    })).json();

    await uploadOpencodeConfig(server.baseUrl, 'e2e-ready-ws', createProviderConfig());

    await fetch(`${server.baseUrl}/api/conversations/e2e-ready-ws/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    await waitForReady(server.baseUrl, 'e2e-ready-ws');

    const ws = await createWSClient(conv.wsUrl);
    try {
      const response = await ws.request('message.send', {
        text: 'Say hello in one word',
      });
      const result = response.result as { messageId: string; text: string; parts: Array<{ type: string; text?: string }> };
      expect(result).toHaveProperty('messageId');
      expect(typeof result.messageId).toBe('string');
      expect(result.messageId).toBeTruthy();
      expect(result).toHaveProperty('text');
      expect(typeof result.text).toBe('string');
      expect(result.text.length).toBeGreaterThan(0);
      expect(result).toHaveProperty('parts');
      expect(Array.isArray(result.parts)).toBe(true);
      expect(result.parts.length).toBeGreaterThan(0);
      expect(result.parts[0].type).toBe('text');
      expect(result.parts[0].text).toBeTruthy();
    } finally {
      ws.close();
    }
  });

  it('shows ready status in conversation list', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations`);
    const body = await res.json() as any[];
    const conv = body.find((c: any) => c.id === 'e2e-ready');
    expect(conv).toBeDefined();
    expect(conv.ready).toBe(true);
  });
});
