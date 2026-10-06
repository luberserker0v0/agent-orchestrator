import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AoApiClient, AoApiError, apiExitCode, readApiKey } from './api-client.js';

describe('AoApiClient', () => {
  let server: Server;
  let baseUrl: string;
  let lastAuthorization: string | undefined;

  beforeEach(async () => {
    server = createServer((request, response) => {
      lastAuthorization = request.headers.authorization;
      if (request.url === '/error') {
        response.writeHead(409, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { code: 'BUSY', message: 'already running' } }));
        return;
      }
      if (request.url === '/malformed') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{');
        return;
      }
      if (request.url === '/empty') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.url === '/slow') return;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, url: request.url }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('sends bearer authentication and decodes JSON', async () => {
    const client = new AoApiClient({ server: baseUrl, apiKey: 'secret-value', timeoutMs: 1_000 });
    await expect(client.request('/ok?x=1')).resolves.toEqual({ ok: true, url: '/ok?x=1' });
    expect(lastAuthorization).toBe('Bearer secret-value');
  });

  it('returns undefined for an empty success response', async () => {
    const client = new AoApiClient({ server: baseUrl, timeoutMs: 1_000 });
    await expect(client.request('/empty')).resolves.toBeUndefined();
  });

  it('maps structured API errors without exposing response bodies', async () => {
    const client = new AoApiClient({ server: baseUrl, timeoutMs: 1_000 });
    await expect(client.request('/error')).rejects.toMatchObject({ status: 409, code: 'BUSY', message: 'already running' });
  });

  it('rejects malformed JSON', async () => {
    const client = new AoApiClient({ server: baseUrl, timeoutMs: 1_000 });
    await expect(client.request('/malformed')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('aborts timed-out requests', async () => {
    const client = new AoApiClient({ server: baseUrl, timeoutMs: 100 });
    await expect(client.request('/slow')).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
  });

  it('maps HTTP categories to stable exit codes', () => {
    expect(apiExitCode(new AoApiError(401, 'NO_AUTH', 'no'))).toBe(3);
    expect(apiExitCode(new AoApiError(404, 'MISSING', 'no'))).toBe(4);
    expect(apiExitCode(new AoApiError(409, 'BUSY', 'no'))).toBe(5);
    expect(apiExitCode(new Error('other'))).toBe(1);
  });

  it('trims key files once and gives them precedence over the environment', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aor-key-test-'));
    const path = join(directory, 'key');
    try {
      writeFileSync(path, '  file-secret\r\n');
      expect(readApiKey(path, { AOR_API_KEY: 'env-secret' })).toBe('file-secret');
      writeFileSync(path, ' \n');
      expect(() => readApiKey(path, { AOR_API_KEY: 'env-secret' })).toThrow(/must not be empty/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects credential-bearing server URLs without echoing credentials', () => {
    expect(() => new AoApiClient({ server: 'https://user:secret@example.test', timeoutMs: 1_000 }))
      .toThrow('Server URL must not contain credentials');
  });
});
