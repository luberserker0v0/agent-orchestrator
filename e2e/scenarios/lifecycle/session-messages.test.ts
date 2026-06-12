import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type E2EServer } from '../../helpers/server.js';
import { createWSClient } from '../../helpers/ws.js';
import { OPENCODE_CONFIG } from '../../../src/test-fixtures/user-configs.js';
import { uploadOpencodeConfig } from '../../../src/test-fixtures/helpers.js';

describe('Session Messages Query (E2E)', () => {
  let server: E2EServer;

  beforeAll(async () => {
    server = await startServer();
    console.log(`[Session Messages] server listening on ${server.baseUrl}`);
  }, 30_000);

  afterAll(async () => {
    for (const id of ['e2e-ses-msg']) {
      try {
        await fetch(`${server.baseUrl}/api/conversations/${id}`, { method: 'DELETE' });
      } catch { /* ignore */ }
    }
    await server.cleanup();
  }, 15_000);

  async function waitForReady(baseUrl: string, conversationId: string): Promise<string> {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(`${baseUrl}/api/conversations/${conversationId}`);
      const body = await res.json() as { ready: boolean; sessionId?: string };
      if (body.ready === true && body.sessionId) return body.sessionId;
    }
    throw new Error('Timed out waiting for ready state');
  }

  let sessionId: string;
  let wsUrl: string;
  let messageId: string;

  it('sets up conversation and sends a message', async () => {
    const createRes = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-ses-msg' }),
    });
    expect(createRes.status).toBe(201);
    const conv = await createRes.json() as { wsUrl: string };
    wsUrl = conv.wsUrl;

    await uploadOpencodeConfig(server.baseUrl, 'e2e-ses-msg', OPENCODE_CONFIG);

    await fetch(`${server.baseUrl}/api/conversations/e2e-ses-msg/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    sessionId = await waitForReady(server.baseUrl, 'e2e-ses-msg');

    const msgRes = await fetch(`${server.baseUrl}/api/conversations/e2e-ses-msg/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Say hello in one word' }),
    });
    expect(msgRes.status).toBe(200);
    const msgBody = await msgRes.json() as { messageId: string };
    messageId = msgBody.messageId;
    expect(messageId).toBeTruthy();
  }, 120_000);

  it('retrieves session messages via REST endpoint', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-ses-msg/sessions/${sessionId}/messages`);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<unknown>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    const first = body[0] as { info: { id: string }; parts: Array<unknown> };
    expect(first).toHaveProperty('info');
    expect(first.info).toHaveProperty('id');
    expect(first).toHaveProperty('parts');
  });

  it('retrieves session messages via WS message.history', async () => {
    const ws = await createWSClient(wsUrl);
    try {
      const response = await ws.request('message.history', { limit: 5 });
      expect(response.result).toBeDefined();
      const msgs = response.result as Array<unknown>;
      expect(Array.isArray(msgs)).toBe(true);
      expect(msgs.length).toBeGreaterThan(0);
    } finally {
      ws.close();
    }
  });

  it('retrieves messages with explicit sessionId via WS', async () => {
    const ws = await createWSClient(wsUrl);
    try {
      const response = await ws.request('message.history', { sessionId, limit: 5 });
      expect(response.result).toBeDefined();
      const msgs = response.result as Array<unknown>;
      expect(Array.isArray(msgs)).toBe(true);
      expect(msgs.length).toBeGreaterThan(0);
    } finally {
      ws.close();
    }
  });

  it('retrieves messages for forked child session', async () => {
    const forkRes = await fetch(`${server.baseUrl}/api/conversations/e2e-ses-msg/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageID: messageId }),
    });
    expect(forkRes.status).toBe(201);
    const forkBody = await forkRes.json() as { id: string };
    expect(forkBody.id).toBeTruthy();
    const childId = forkBody.id;

    const childMsgs = await fetch(`${server.baseUrl}/api/conversations/e2e-ses-msg/sessions/${childId}/messages`);
    expect(childMsgs.status).toBe(200);
    const childMsgsBody = await childMsgs.json() as Array<unknown>;
    expect(Array.isArray(childMsgsBody)).toBe(true);

    const ws = await createWSClient(wsUrl);
    try {
      const response = await ws.request('message.history', { sessionId: childId, limit: 5 });
      expect(response.result).toBeDefined();
      const msgs = response.result as Array<unknown>;
      expect(Array.isArray(msgs)).toBe(true);
    } finally {
      ws.close();
    }
  });
});
