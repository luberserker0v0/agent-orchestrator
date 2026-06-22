import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type E2EServer } from '../../helpers/server.js';
import { createWSClient, type JSONRPCEvent } from '../../helpers/ws.js';
import { OPENCODE_CONFIG } from '../../../src/test-fixtures/user-configs.js';
import { uploadOpencodeConfig } from '../../../src/test-fixtures/helpers.js';

describe('WebSocket event reception from HTTP and WS message sends (E2E)', () => {
  let server: E2EServer;

  beforeAll(async () => {
    server = await startServer();
  }, 30_000);

  afterAll(async () => {
    const ids = ['e2e-ws-event-http', 'e2e-ws-event-ws'];
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

  async function waitForEvent(
    events: JSONRPCEvent[],
    method: string,
    timeoutMs = 5000
  ): Promise<JSONRPCEvent | undefined> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = events.find((e) => e.method === method);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    return events.find((e) => e.method === method);
  }

  it('receives conversation.message event via WS when message is sent via HTTP', async () => {
    const createRes = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-ws-event-http' }),
    });
    expect(createRes.status).toBe(201);

    await uploadOpencodeConfig(server.baseUrl, 'e2e-ws-event-http', OPENCODE_CONFIG);

    await fetch(`${server.baseUrl}/api/conversations/e2e-ws-event-http/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    await waitForReady(server.baseUrl, 'e2e-ws-event-http');

    const ws = await createWSClient(`${server.baseUrl.replace(/^http/, 'ws')}/ws/e2e-ws-event-http`);
    try {
      const receivedEvents: JSONRPCEvent[] = [];
      ws.onEvent((event) => { receivedEvents.push(event); });

      const msgRes = await fetch(`${server.baseUrl}/api/conversations/e2e-ws-event-http/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Say hello in one word', model: OPENCODE_CONFIG.model }),
      });
      expect(msgRes.status).toBe(200);
      const httpBody = await msgRes.json() as { messageId: string; text: string };

      const messageEvent = receivedEvents.find((e) => e.method === 'conversation.message');
      expect(messageEvent).toBeDefined();
      expect(messageEvent!.params).toHaveProperty('messageId', httpBody.messageId);
      expect(messageEvent!.params).toHaveProperty('text', httpBody.text);
      expect(messageEvent!.params).toHaveProperty('role', 'assistant');
    } finally {
      ws.close();
    }
  });

  it('sends and receives conversation.message event on same WS connection', async () => {
    const createRes = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-ws-event-ws' }),
    });
    expect(createRes.status).toBe(201);

    await uploadOpencodeConfig(server.baseUrl, 'e2e-ws-event-ws', OPENCODE_CONFIG);

    await fetch(`${server.baseUrl}/api/conversations/e2e-ws-event-ws/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    await waitForReady(server.baseUrl, 'e2e-ws-event-ws');

    const ws = await createWSClient(`${server.baseUrl.replace(/^http/, 'ws')}/ws/e2e-ws-event-ws`);
    try {
      const events: JSONRPCEvent[] = [];
      ws.onEvent((event) => { events.push(event); });

      const response = await ws.request('message.send', {
        text: 'Say hello in one word',
        model: OPENCODE_CONFIG.model,
      });
      const result = response.result as { messageId: string; text: string };

      const messageEvent = await waitForEvent(events, 'conversation.message');
      expect(messageEvent).toBeDefined();
      expect(messageEvent!.params).toHaveProperty('messageId', result.messageId);
      expect(messageEvent!.params).toHaveProperty('text', result.text);
      expect(messageEvent!.params).toHaveProperty('role', 'assistant');
    } finally {
      ws.close();
    }
  });
});
