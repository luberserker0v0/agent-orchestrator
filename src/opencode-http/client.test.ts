import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenCodeAgentClient } from './client.js';

function mockFetch(response?: Partial<Response>) {
  const defaultResponse: Partial<Response> = {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(''),
    ...response,
  };
  const fetchFn = vi.fn().mockResolvedValue(defaultResponse);
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}

describe('OpenCodeAgentClient', () => {
  let client: OpenCodeAgentClient;
  let fetchFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new OpenCodeAgentClient('http://localhost:3000');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('constructs with trailing slash removed', () => {
    const c = new OpenCodeAgentClient('http://localhost:3000/');
    expect((c as any).baseUrl).toBe('http://localhost:3000');
  });

  it('sets auth header when username and password provided', () => {
    const c = new OpenCodeAgentClient('http://localhost:3000', 'user', 'pass');
    expect((c as any).authHeader).toContain('Basic ');
  });

  it('does not set auth header without credentials', () => {
    expect((client as any).authHeader).toBeUndefined();
  });

  describe('health', () => {
    it('returns health status', async () => {
      fetchFn = mockFetch({ json: vi.fn().mockResolvedValue({ healthy: true, version: '1.0.0' }) });
      const result = await client.health();
      expect(fetchFn).toHaveBeenCalledWith('http://localhost:3000/global/health', expect.objectContaining({ method: 'GET' }));
      expect(result.healthy).toBe(true);
    });

    it('passes abort signal', async () => {
      fetchFn = mockFetch();
      const ac = new AbortController();
      await client.health(ac.signal);
      const [, opts] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('createSession', () => {
    it('sends POST with body', async () => {
      fetchFn = mockFetch({ json: vi.fn().mockResolvedValue({ id: 'ses_1' }) });
      const result = await client.createSession({ title: 'test' });
      expect(fetchFn).toHaveBeenCalledWith('http://localhost:3000/session', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'test' }),
      }));
      expect(result.id).toBe('ses_1');
    });
  });

  describe('getSession', () => {
    it('returns session by id', async () => {
      fetchFn = mockFetch({ json: vi.fn().mockResolvedValue({ id: 'ses_1', title: 'Test' }) });
      const result = await client.getSession('ses_1');
      expect(fetchFn).toHaveBeenCalledWith('http://localhost:3000/session/ses_1', expect.objectContaining({ method: 'GET' }));
      expect(result.title).toBe('Test');
    });
  });

  describe('deleteSession', () => {
    it('deletes session', async () => {
      fetchFn = mockFetch({ json: vi.fn().mockResolvedValue(true) });
      const result = await client.deleteSession('ses_1');
      expect(fetchFn).toHaveBeenCalledWith('http://localhost:3000/session/ses_1', expect.objectContaining({ method: 'DELETE' }));
      expect(result).toBe(true);
    });
  });

  describe('listMessages', () => {
    it('returns messages without limit', async () => {
      fetchFn = mockFetch({ json: vi.fn().mockResolvedValue([{ info: { id: 'msg_1' }, parts: [] }]) });
      const result = await client.listMessages('ses_1');
      expect(fetchFn).toHaveBeenCalledWith('http://localhost:3000/session/ses_1/message', expect.any(Object));
      expect(result).toHaveLength(1);
    });

    it('includes limit query param', async () => {
      fetchFn = mockFetch();
      await client.listMessages('ses_1', 10);
      expect(fetchFn).toHaveBeenCalledWith('http://localhost:3000/session/ses_1/message?limit=10', expect.any(Object));
    });
  });

  describe('sendPrompt', () => {
    it('sends prompt', async () => {
      fetchFn = mockFetch({ json: vi.fn().mockResolvedValue({ info: { id: 'msg_1' }, parts: [] }) });
      const result = await client.sendPrompt('ses_1', { parts: [{ type: 'text', text: 'Hi' }] });
      expect(fetchFn).toHaveBeenCalledWith('http://localhost:3000/session/ses_1/message', expect.objectContaining({ method: 'POST' }));
      expect(result.info.id).toBe('msg_1');
    });
  });

  describe('abortSession', () => {
    it('aborts session', async () => {
      fetchFn = mockFetch({ json: vi.fn().mockResolvedValue(true) });
      const result = await client.abortSession('ses_1');
      expect(fetchFn).toHaveBeenCalledWith('http://localhost:3000/session/ses_1/abort', expect.objectContaining({ method: 'POST' }));
      expect(result).toBe(true);
    });
  });

  describe('listSessions', () => {
    it('lists sessions', async () => {
      fetchFn = mockFetch({ json: vi.fn().mockResolvedValue([{ id: 'ses_1' }]) });
      const result = await client.listSessions();
      expect(fetchFn).toHaveBeenCalledWith('http://localhost:3000/session', expect.objectContaining({ method: 'GET' }));
      expect(result).toHaveLength(1);
    });
  });

  describe('getSessionChildren', () => {
    it('returns session children', async () => {
      fetchFn = mockFetch({ json: vi.fn().mockResolvedValue([{ id: 'child_1' }]) });
      const result = await client.getSessionChildren('ses_1');
      expect(fetchFn).toHaveBeenCalledWith('http://localhost:3000/session/ses_1/children', expect.objectContaining({ method: 'GET' }));
      expect(result).toHaveLength(1);
    });
  });

  describe('forkSession', () => {
    it('forks session with messageID', async () => {
      fetchFn = mockFetch({ json: vi.fn().mockResolvedValue({ id: 'forked' }) });
      const result = await client.forkSession('ses_1', 'msg_1');
      expect(fetchFn).toHaveBeenCalledWith('http://localhost:3000/session/ses_1/fork', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ messageID: 'msg_1' }),
      }));
      expect(result.id).toBe('forked');
    });

    it('forks session without messageID', async () => {
      fetchFn = mockFetch({ json: vi.fn().mockResolvedValue({ id: 'forked' }) });
      await client.forkSession('ses_1');
      expect(fetchFn).toHaveBeenCalledWith('http://localhost:3000/session/ses_1/fork', expect.objectContaining({
        method: 'POST',
      }));
      const initArg = fetchFn.mock.calls[0][1] as Record<string, unknown>;
      expect(initArg.body).toBeUndefined();
    });
  });

  describe('listAgents', () => {
    it('lists agents', async () => {
      fetchFn = mockFetch({ json: vi.fn().mockResolvedValue([{ id: 'agent_1', name: 'designer' }]) });
      const result = await client.listAgents();
      expect(fetchFn).toHaveBeenCalledWith('http://localhost:3000/agent', expect.objectContaining({ method: 'GET' }));
      expect(result).toHaveLength(1);
    });
  });

  describe('listProviders', () => {
    it('lists providers', async () => {
      fetchFn = mockFetch({ json: vi.fn().mockResolvedValue({ providers: [], default: {} }) });
      const result = await client.listProviders();
      expect(fetchFn).toHaveBeenCalledWith('http://localhost:3000/config/providers', expect.objectContaining({ method: 'GET' }));
      expect(result.providers).toEqual([]);
    });
  });

  describe('getConfig', () => {
    it('returns config', async () => {
      fetchFn = mockFetch({ json: vi.fn().mockResolvedValue({ model: 'gpt-4' }) });
      const result = await client.getConfig();
      expect(fetchFn).toHaveBeenCalledWith('http://localhost:3000/config', expect.objectContaining({ method: 'GET' }));
      expect(result.model).toBe('gpt-4');
    });
  });

  describe('error handling', () => {
    it('throws on non-ok response', async () => {
      fetchFn = mockFetch({ ok: false, status: 404, text: vi.fn().mockResolvedValue('Not found') });
      await expect(client.getSession('bad')).rejects.toThrow('OpenCode HTTP 404: Not found');
    });

    it('uses fallback text on error response with no body', async () => {
      fetchFn = mockFetch({ ok: false, status: 500, text: vi.fn().mockRejectedValue(new Error('no body')) });
      await expect(client.health()).rejects.toThrow('OpenCode HTTP 500: Unknown error');
    });

    it('returns undefined for 204', async () => {
      fetchFn = mockFetch({ ok: true, status: 204, json: vi.fn() });
      const result = await client.deleteSession('ses_1');
      expect(result).toBeUndefined();
    });
  });
});
