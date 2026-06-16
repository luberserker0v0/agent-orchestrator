import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, type E2EServer } from '../../helpers/server.js';

describe('Workspace: Agent CRUD (E2E)', () => {
  let server: E2EServer;

  beforeAll(async () => {
    server = await startServer();
  }, 30_000);

  afterAll(async () => {
    await server.cleanup();
  }, 15_000);

  it('creates a conversation for agent operations', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-agents' }),
    });
    expect(res.status).toBe(201);
  });

  it('writes an agent', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-agents/agents`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'tester',
        content: '---\nname: Tester\n---\nYou are a tester.',
      }),
    });
    expect(res.status).toBe(204);
  });

  it('reads agent content', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-agents/agents/tester`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe('tester');
    expect(body.content).toContain('You are a tester.');
  });

  it('returns 404 for missing agent', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-agents/agents/missing.md`);
    expect(res.status).toBe(404);
  });

  it('lists agents', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-agents/agents`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.some((a: string) => a === 'tester')).toBe(true);
  });

  it('deletes agent', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-agents/agents/tester`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
  });

  it('returns 404 after deletion', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-agents/agents/tester`);
    expect(res.status).toBe(404);
  });

  it('deletes conversation and cleans up workspace folder', async () => {
    const wsPath = join(server.workspaceDir, 'e2e-agents');
    expect(existsSync(wsPath)).toBe(true);

    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-agents`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);

    for (let i = 0; i < 30; i++) {
      if (!existsSync(wsPath)) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    expect(existsSync(wsPath)).toBe(false);
  });
});
