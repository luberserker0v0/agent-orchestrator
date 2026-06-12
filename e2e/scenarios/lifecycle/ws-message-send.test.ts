import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type E2EServer } from '../../helpers/server.js';
import { createWSClient } from '../../helpers/ws.js';
import { OPENCODE_CONFIG } from '../../../src/test-fixtures/user-configs.js';
import { uploadOpencodeConfig } from '../../../src/test-fixtures/helpers.js';

describe('WebSocket JSON-RPC message.send (E2E)', () => {
  let server: E2EServer;

  beforeAll(async () => {
    server = await startServer();
    console.log(`[WebSocket JSON-RPC message.send (E2E)] server is listening on ${server.baseUrl}`)
  }, 30_000);

  afterAll(async () => {
    const ids = ['e2e-msg-ws', 'e2e-msg-ws-notready', 'e2e-msg-ws-notext'];
    for (const id of ids) {
      try {
        await fetch(`${server.baseUrl}/api/conversations/${id}`, { method: 'DELETE' });
      } catch { /* ignore */ }
    }
    await server.cleanup();
  }, 15_000);

  async function waitForReady(baseUrl: string, conversationId: string): Promise<void> {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(`${baseUrl}/api/conversations/${conversationId}`);
      const body = await res.json() as { ready: boolean; sessionId?: string };
      if (body.ready === true && body.sessionId) return;
    }
    throw new Error('Timed out waiting for ready state');
  }

  it('sends message via WebSocket and returns result with messageId, text, parts', async () => {
    const createRes = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-msg-ws' }),
    });
    const conv = await createRes.json() as { wsUrl: string };
    expect(createRes.status).toBe(201);

    await uploadOpencodeConfig(server.baseUrl, 'e2e-msg-ws', OPENCODE_CONFIG);

    await fetch(`${server.baseUrl}/api/conversations/e2e-msg-ws/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    await waitForReady(server.baseUrl, 'e2e-msg-ws');

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
      expect(result.parts[1].type).toBe('text');
      expect(result.parts[1].text).toBeTruthy();
    } finally {
      ws.close();
    }
  });

  it('returns error when conversation is not ready', async () => {
    const createRes = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-msg-ws-notready' }),
    });
    const conv = await createRes.json() as { wsUrl: string };

    const ws = await createWSClient(conv.wsUrl);
    try {
      await expect(ws.request('message.send', { text: 'hello' })).rejects.toThrow('Conversation is not running');
    } finally {
      ws.close();
    }
  });

  it('returns error when text is missing', async () => {
    const createRes = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-msg-ws-notext' }),
    });
    const conv = await createRes.json() as { wsUrl: string };

    await uploadOpencodeConfig(server.baseUrl, 'e2e-msg-ws-notext', OPENCODE_CONFIG);

    await fetch(`${server.baseUrl}/api/conversations/e2e-msg-ws-notext/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    await waitForReady(server.baseUrl, 'e2e-msg-ws-notext');

    const ws = await createWSClient(conv.wsUrl);
    try {
      await expect(ws.request('message.send', {})).rejects.toThrow('Missing text');
    } finally {
      ws.close();
    }
  });
});
