import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenCodeClient } from './client.js';

describe('OpenCodeClient', () => {
  let client: OpenCodeClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new OpenCodeClient('http://localhost:3000', 'opencode', 'secret');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function mockResponse(status: number, body: unknown, statusText = 'OK') {
    const res = {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      text: vi.fn().mockResolvedValue(JSON.stringify(body)),
      json: vi.fn().mockResolvedValue(body),
    };
    fetchMock.mockResolvedValue(res);
    return res;
  }

  it('makes GET request for health()', async () => {
    mockResponse(200, { healthy: true, version: '1.0.0' });

    const result = await client.health();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3000/global/health');
    expect(init.method).toBe('GET');
    expect(result.healthy).toBe(true);
  });

  it('makes POST request with body for createSession()', async () => {
    mockResponse(200, {
      id: 'ses_1',
      title: 'Test',
      parent_id: null,
      status: 'active',
      created_at: '',
      updated_at: '',
    });

    await client.createSession({ title: 'Test' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3000/session');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ title: 'Test' });
  });

  it('makes DELETE request for deleteSession()', async () => {
    mockResponse(204, undefined);

    const result = await client.deleteSession('ses_1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3000/session/ses_1');
    expect(init.method).toBe('DELETE');
    expect(result).toBeUndefined();
  });

  it('appends query string for listMessages(limit)', async () => {
    mockResponse(200, []);

    await client.listMessages('ses_1', 10);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3000/session/ses_1/message?limit=10');
  });

  it('makes POST request with body for sendPrompt()', async () => {
    mockResponse(200, {
      info: { id: 'msg_1', session_id: 'ses_1', role: 'assistant', created_at: '', updated_at: '' },
      parts: [{ type: 'text', text: 'Hello' }],
    });

    await client.sendPrompt('ses_1', { parts: [{ type: 'text', text: 'Hi' }] });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3000/session/ses_1/message');
    expect(init.method).toBe('POST');
  });

  it('sets Basic Auth header when username/password provided', async () => {
    mockResponse(200, { healthy: true, version: '1.0.0' });

    await client.health();

    const [, init] = fetchMock.mock.calls[0];
    const expectedAuth = 'Basic ' + Buffer.from('opencode:secret').toString('base64');
    expect(init.headers['Authorization']).toBe(expectedAuth);
  });

  it('does not set Auth header when credentials omitted', async () => {
    const noAuthClient = new OpenCodeClient('http://localhost:3000');
    mockResponse(200, { healthy: true, version: '1.0.0' });

    await noAuthClient.health();

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['Authorization']).toBeUndefined();
  });

  it('throws on HTTP 4xx/5xx with status and body', async () => {
    const res = {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: vi.fn().mockResolvedValue('Invalid credentials'),
    };
    fetchMock.mockResolvedValue(res);

    await expect(client.health()).rejects.toThrow('OpenCode HTTP 401: Invalid credentials');
  });

  it('throws on network error', async () => {
    fetchMock.mockRejectedValue(new Error('Network failure'));

    await expect(client.health()).rejects.toThrow('Network failure');
  });

  it('passes AbortSignal to fetch', async () => {
    mockResponse(200, { healthy: true, version: '1.0.0' });
    const controller = new AbortController();

    await client.health(controller.signal);

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBe(controller.signal);
  });

  it('returns undefined for 204 No Content', async () => {
    const res = {
      ok: true,
      status: 204,
      statusText: 'No Content',
      text: vi.fn().mockResolvedValue(''),
      json: vi.fn().mockRejectedValue(new Error('Empty body')),
    };
    fetchMock.mockResolvedValue(res);

    const result = await client.deleteSession('ses_1');
    expect(result).toBeUndefined();
  });
});
