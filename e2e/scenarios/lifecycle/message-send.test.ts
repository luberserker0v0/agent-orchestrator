import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type E2EServer } from '../../helpers/server.js';
import { createWSClient } from '../../helpers/ws.js';
import { createProviderConfig } from '../../../src/test-fixtures/user-configs.js';
import { uploadOpencodeConfig } from '../../../src/test-fixtures/helpers.js';

describe('Message Send (E2E)', () => {
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
      const body = await res.json() as { ready: boolean; sessionId?: string };
      if (body.ready === true && body.sessionId) return;
    }
    throw new Error('Timed out waiting for ready state');
  }

  describe('HTTP POST /api/conversations/:id/message', () => {
    it('sends message and returns messageId, text, parts', async () => {
      const createRes = await fetch(`${server.baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'e2e-msg-http' }),
      });
      expect(createRes.status).toBe(201);
      await uploadOpencodeConfig(server.baseUrl, 'e2e-msg-http', createProviderConfig());

      await fetch(`${server.baseUrl}/api/conversations/e2e-msg-http/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      await waitForReady(server.baseUrl, 'e2e-msg-http');

      const msgRes = await fetch(`${server.baseUrl}/api/conversations/e2e-msg-http/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Say hello in one word' }),
      });
      expect(msgRes.status).toBe(200);
      const body = await msgRes.json() as { messageId: string; text: string; parts: Array<{ type: string; text?: string }> };
      expect(body).toHaveProperty('messageId');
      expect(typeof body.messageId).toBe('string');
      expect(body.messageId).toBeTruthy();
      expect(body).toHaveProperty('text');
      expect(typeof body.text).toBe('string');
      expect(body.text.length).toBeGreaterThan(0);
      expect(body).toHaveProperty('parts');
      expect(Array.isArray(body.parts)).toBe(true);
      expect(body.parts.length).toBeGreaterThan(0);
      expect(body.parts[0].type).toBe('text');
      expect(body.parts[0].text).toBeTruthy();
    });

    it('returns 400 for missing text', async () => {
      const res = await fetch(`${server.baseUrl}/api/conversations/e2e-msg-http/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('returns 409 for non-running conversation', async () => {
      await fetch(`${server.baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'e2e-msg-notrunning' }),
      });
      const res = await fetch(`${server.baseUrl}/api/conversations/e2e-msg-notrunning/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(res.status).toBe(409);
    });
  });

  describe('WebSocket JSON-RPC message.send', () => {
    it('sends message via WebSocket and returns result with messageId, text, parts', async () => {
      const createRes = await fetch(`${server.baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'e2e-msg-ws' }),
      });
      const conv = await createRes.json() as { wsUrl: string };
      expect(createRes.status).toBe(201);

      await uploadOpencodeConfig(server.baseUrl, 'e2e-msg-ws', createProviderConfig());

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
        expect(result.parts[0].type).toBe('text');
        expect(result.parts[0].text).toBeTruthy();
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

      await uploadOpencodeConfig(server.baseUrl, 'e2e-msg-ws-notext', createProviderConfig());

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
});
