import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type E2EServer } from '../../helpers/server.js';
import { OPENCODE_CONFIG } from '../../../src/test-fixtures/user-configs.js';
import { uploadOpencodeConfig } from '../../../src/test-fixtures/helpers.js';

describe('HTTP POST /api/conversations/:id/message (E2E)', () => {
  let server: E2EServer;

  beforeAll(async () => {
    server = await startServer();
  }, 30_000);

  afterAll(async () => {
    const ids = ['e2e-msg-http', 'e2e-msg-notrunning'];
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

  it('sends message and returns messageId, text, parts', async () => {
    const createRes = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-msg-http' }),
    });
    expect(createRes.status).toBe(201);
    await uploadOpencodeConfig(server.baseUrl, 'e2e-msg-http', OPENCODE_CONFIG);

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
    const restTextPart = body.parts.find(p => p.type === 'text');
    expect(restTextPart).toBeTruthy();
    expect(restTextPart!.text).toBeTruthy();
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
