import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type E2EServer } from '../../helpers/server.js';
import { createWSClient } from '../../helpers/ws.js';

describe('WS Lifecycle (E2E)', () => {
  let server: E2EServer;
  let wsUrl: string;
  let wsUrl2: string;
  let wsUrl3: string;

  beforeAll(async () => {
    server = await startServer();
  }, 30_000);

  afterAll(async () => {
    const ids = ['e2e-ws-lifecycle', 'e2e-ws-stop-prepared', 'e2e-ws-restart-prepared'];
    for (const id of ids) {
      try {
        await fetch(`${server.baseUrl}/api/conversations/${id}`, { method: 'DELETE' });
      } catch {
        // ignore cleanup errors
      }
    }
    await server.cleanup();
  }, 15_000);

  it('returns correct status via WS for prepared conversation', async () => {
    const createRes = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-ws-lifecycle' }),
    });
    expect(createRes.status).toBe(201);
    const conv = await createRes.json() as { wsUrl: string };
    wsUrl = conv.wsUrl;

    const ws = await createWSClient(wsUrl);
    try {
      const response = await ws.request('conversation.status', {});
      const result = response.result as { status: string; ready: boolean };
      expect(result.status).toBe('prepared');
      expect(result.ready).toBe(false);
      expect(result).toHaveProperty('id', 'e2e-ws-lifecycle');
    } finally {
      ws.close();
    }
  });

  it('starts conversation via WS and returns running status', async () => {
    const ws = await createWSClient(wsUrl);
    try {
      const response = await ws.request('conversation.start', {});
      const result = response.result as { status: string };
      expect(result.status).toBe('running');
    } finally {
      ws.close();
    }
  });

  it('rejects duplicate start via WS', async () => {
    const ws = await createWSClient(wsUrl);
    try {
      await expect(ws.request('conversation.start', {}))
        .rejects.toThrow('already starting or running');
    } finally {
      ws.close();
    }
  });

  it('returns running status via WS after start', async () => {
    const ws = await createWSClient(wsUrl);
    try {
      const response = await ws.request('conversation.status', {});
      const result = response.result as { status: string };
      expect(result.status).toBe('running');
    } finally {
      ws.close();
    }
  });

  it('stops conversation via WS and returns stopped status', async () => {
    const ws = await createWSClient(wsUrl);
    try {
      const response = await ws.request('conversation.stop', {});
      const result = response.result as { status: string };
      expect(result.status).toBe('stopped');
    } finally {
      ws.close();
    }
  });

  it('returns stopped status via WS after stop', async () => {
    const ws = await createWSClient(wsUrl);
    try {
      const response = await ws.request('conversation.status', {});
      const result = response.result as { status: string };
      expect(result.status).toBe('stopped');
    } finally {
      ws.close();
    }
  });

  it('starts again after stop via WS', async () => {
    const ws = await createWSClient(wsUrl);
    try {
      const response = await ws.request('conversation.start', {});
      const result = response.result as { status: string };
      expect(result.status).toBe('running');
    } finally {
      ws.close();
    }
  });

  it('restarts running conversation via WS', async () => {
    const ws = await createWSClient(wsUrl);
    try {
      const response = await ws.request('conversation.restart', {});
      const result = response.result as { status: string };
      expect(result.status).toBe('running');
    } finally {
      ws.close();
    }
  });

  it('rejects stop for prepared (not started) conversation via WS', async () => {
    const createRes = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-ws-stop-prepared' }),
    });
    expect(createRes.status).toBe(201);
    const conv = await createRes.json() as { wsUrl: string };
    wsUrl2 = conv.wsUrl;

    const ws = await createWSClient(wsUrl2);
    try {
      await expect(ws.request('conversation.stop', {}))
        .rejects.toThrow('Cannot stop conversation');
    } finally {
      ws.close();
    }
  });

  it('rejects restart for prepared conversation via WS', async () => {
    const createRes = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-ws-restart-prepared' }),
    });
    expect(createRes.status).toBe(201);
    const conv = await createRes.json() as { wsUrl: string };
    wsUrl3 = conv.wsUrl;

    const ws = await createWSClient(wsUrl3);
    try {
      await expect(ws.request('conversation.restart', {}))
        .rejects.toThrow('Cannot restart conversation');
    } finally {
      ws.close();
    }
  });
});
