import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type E2EServer } from '../helpers/server.js';

describe('Conversation Lifecycle (E2E)', () => {
  let server: E2EServer;

  beforeAll(async () => {
    server = await startServer();
  }, 30_000);

  afterAll(async () => {
    await server.cleanup();
  }, 15_000);

  it('creates a conversation (prepared)', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-lifecycle' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe('e2e-lifecycle');
    expect(body.status).toBe('prepared');
    expect(body.wsUrl).toContain('/ws/e2e-lifecycle');
  });

  it('lists conversations', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((c: any) => c.id === 'e2e-lifecycle')).toBe(true);
  });

  it('gets conversation details', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-lifecycle`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('e2e-lifecycle');
    expect(body.status).toBe('prepared');
    expect(body.ready).toBe(false);
  });

  it('rejects duplicate create', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-lifecycle' }),
    });
    expect(res.status).toBe(409);
  });

  it('starts conversation', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-lifecycle/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('running');
    expect(body.ready).toBe(false);
    expect(typeof body.port).toBe('number');
    expect(typeof body.sessionId).toBe('string');
    expect(body.wsUrl).toContain('/ws/e2e-lifecycle');
  });

  it('rejects start when already running', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-lifecycle/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(409);
  });

  it('stops conversation', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-lifecycle/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('stopped');
  });

  it('restarts conversation after stop', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-lifecycle/restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('running');
    expect(typeof body.port).toBe('number');
  });

  it('deletes conversation', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-lifecycle`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
  });

  it('returns 404 for deleted conversation', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-lifecycle`);
    expect(res.status).toBe(404);
  });
});
