import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, type E2EServer } from '../../helpers/server.js';
import { OPENCODE_CONFIG } from '../../../src/test-fixtures/user-configs.js';
import { uploadOpencodeConfig } from '../../../src/test-fixtures/helpers.js';

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

  it('uploads provider config and starts conversation', async () => {
    await uploadOpencodeConfig(server.baseUrl, 'e2e-lifecycle', OPENCODE_CONFIG);

    const startRes = await fetch(`${server.baseUrl}/api/conversations/e2e-lifecycle/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(startRes.status).toBe(200);
    const body = await startRes.json();
    expect(body.status).toBe('running');
    expect(body.ready).toBe(false);
    expect(typeof body.port).toBe('number');
    expect(body.sessionId).toBeUndefined();
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

  it('deletes conversation and cleans up workspace folder', async () => {
    const wsPath = join(server.workspaceDir, 'e2e-lifecycle');
    expect(existsSync(wsPath)).toBe(true);

    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-lifecycle`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);

    // Workspace folder should be removed within 30s (background cleanup retries)
    for (let i = 0; i < 30; i++) {
      if (!existsSync(wsPath)) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    expect(existsSync(wsPath)).toBe(false);
  });

  it('returns 404 for deleted conversation', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-lifecycle`);
    expect(res.status).toBe(404);
  });
});
