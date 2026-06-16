import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, type E2EServer } from '../../helpers/server.js';

describe('Workspace: File CRUD (E2E)', () => {
  let server: E2EServer;

  beforeAll(async () => {
    server = await startServer();
  }, 30_000);

  afterAll(async () => {
    await server.cleanup();
  }, 15_000);

  it('creates a conversation for file operations', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-files' }),
    });
    expect(res.status).toBe(201);
  });

  it('writes a file', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-files/files`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'test/hello.txt', content: 'Hello from e2e' }),
    });
    expect(res.status).toBe(204);
  });

  it('reads file content', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-files/files/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'test/hello.txt' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe('test/hello.txt');
    expect(body.content).toBe('Hello from e2e');
  });

  it('returns 404 for missing file', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-files/files/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'nonexistent.txt' }),
    });
    expect(res.status).toBe(404);
  });

  it('lists files', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-files/files/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.files).toBeDefined();
    expect(Array.isArray(body.files)).toBe(true);
  });

  it('rejects path traversal', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-files/files`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '../../../etc/passwd', content: 'evil' }),
    });
    expect(res.status).toBe(400);
  });

  it('deletes file', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-files/files/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'test/hello.txt' }),
    });
    expect(res.status).toBe(204);
  });

  it('returns 404 after deletion', async () => {
    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-files/files/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'test/hello.txt' }),
    });
    expect(res.status).toBe(404);
  });

  it('deletes conversation and cleans up workspace folder', async () => {
    const wsPath = join(server.workspaceDir, 'e2e-files');
    expect(existsSync(wsPath)).toBe(true);

    const res = await fetch(`${server.baseUrl}/api/conversations/e2e-files`, {
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
