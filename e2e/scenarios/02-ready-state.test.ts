import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type E2EServer } from '../helpers/server.js';
import { createWSClient } from '../helpers/ws.js';
import { opencodeConfigWithProvider } from '../../src/test-fixtures/user-configs.js';
import { uploadOpencodeConfig } from '../../src/test-fixtures/helpers.js';

describe('Ready State (E2E)', () => {
  let server: E2EServer;

  beforeAll(async () => {
    server = await startServer();
  }, 30_000);

  afterAll(async () => {
    await server.cleanup();
  }, 15_000);

  it('transitions to ready after start', async () => {
    await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-ready' }),
    });

    await uploadOpencodeConfig(server.baseUrl, 'e2e-ready', opencodeConfigWithProvider);

    const startRes = await fetch(`${server.baseUrl}/api/conversations/e2e-ready/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(startRes.status).toBe(200);
    expect((await startRes.json()).ready).toBe(false);

    let ready = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const res = await fetch(`${server.baseUrl}/api/conversations/e2e-ready`);
      const body = await res.json();
      if (body.ready === true) {
        ready = true;
        break;
      }
    }
    expect(ready).toBe(true);
  });

  it('sends message via WebSocket after ready', async () => {
    const conv = await (await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-ready-ws' }),
    })).json();

    await uploadOpencodeConfig(server.baseUrl, 'e2e-ready-ws', opencodeConfigWithProvider);

    await fetch(`${server.baseUrl}/api/conversations/e2e-ready-ws/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    let ready = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const res = await fetch(`${server.baseUrl}/api/conversations/e2e-ready-ws`);
      const body = await res.json();
      if (body.ready === true) {
        ready = true;
        break;
      }
    }
    expect(ready).toBe(true);

    const ws = await createWSClient(conv.wsUrl);

    ws.close();
  });

  it('shows ready status in conversation list', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations`);
    const body = await res.json() as any[];
    const conv = body.find((c: any) => c.id === 'e2e-ready');
    expect(conv).toBeDefined();
    expect(conv.ready).toBe(true);
  });
});
