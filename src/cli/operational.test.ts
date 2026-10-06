import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeCli } from '../cli.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(value === undefined ? undefined : JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('operational CLI commands', () => {
  const output: string[] = [];

  beforeEach(() => {
    output.length = 0;
    process.exitCode = undefined;
    vi.spyOn(process.stdout, 'write').mockImplementation(value => {
      output.push(String(value));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.AOR_API_KEY;
    process.exitCode = undefined;
  });

  it('reports health and authenticated role as JSON', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }))
      .mockResolvedValueOnce(jsonResponse({ role: 'admin' }));
    vi.stubGlobal('fetch', fetchMock);
    await executeCli(['--json', '--server', 'http://ao.test', 'status']);
    expect(JSON.parse(output.join(''))).toEqual({
      server: 'http://ao.test',
      health: { status: 'ok' },
      auth: { role: 'admin' },
    });
  });

  it('returns metrics without contaminating JSON output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('metric_total 1\n', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })));
    await executeCli(['metrics', '--json']);
    expect(JSON.parse(output.join(''))).toEqual({ metrics: 'metric_total 1\n' });
  });

  it.each([
    { args: ['conversation', 'list'], path: '/api/conversations', method: 'GET' },
    { args: ['conversation', 'get', 'demo/id'], path: '/api/conversations/demo%2Fid', method: 'GET' },
    { args: ['conversation', 'start', 'demo'], path: '/api/conversations/demo/start', method: 'POST' },
    { args: ['conversation', 'stop', 'demo'], path: '/api/conversations/demo/stop', method: 'POST' },
    { args: ['conversation', 'restart', 'demo'], path: '/api/conversations/demo/restart', method: 'POST' },
    { args: ['conversation', 'events', 'demo', '--limit', '12'], path: '/api/conversations/demo/events?limit=12', method: 'GET' },
    { args: ['conversation', 'migrate', 'demo', '--node', 'worker-a'], path: '/api/conversations/demo/migrate', method: 'POST', body: { nodeName: 'worker-a' } },
    { args: ['session', 'list', 'demo'], path: '/api/conversations/demo/sessions', method: 'GET' },
    { args: ['session', 'get', 'demo', 'ses/1'], path: '/api/conversations/demo/sessions/ses%2F1', method: 'GET' },
    { args: ['session', 'create', 'demo', '--title', 'Work', '--parent', 'parent'], path: '/api/conversations/demo/sessions', method: 'POST', body: { title: 'Work', parentID: 'parent' } },
    { args: ['session', 'fork', 'demo', 'ses', '--message', 'msg'], path: '/api/conversations/demo/sessions/ses/fork', method: 'POST', body: { messageID: 'msg' } },
    { args: ['session', 'messages', 'demo', 'ses', '--limit', '7'], path: '/api/conversations/demo/sessions/ses/messages?limit=7', method: 'GET' },
    { args: ['session', 'abort', 'demo'], path: '/api/conversations/demo/sessions/abort', method: 'POST' },
    { args: ['cleanup', 'preview', '--target', 'persistentData'], path: '/api/cleanup/preview', method: 'POST', body: { targets: ['persistentData'] } },
    { args: ['message', 'send', 'demo', '--text', 'hello', '--model', 'openai/gpt', '--agent', 'reviewer'], path: '/api/conversations/demo/message', method: 'POST', body: { text: 'hello', model: 'openai/gpt', agent: 'reviewer' } },
  ])('maps $args to $method $path', async ({ args, path, method, body }) => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await executeCli([...args, '--server', 'http://ao.test', '--json']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`http://ao.test${path}`);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe(method);
    if (body) expect(JSON.parse(String(init.body))).toEqual(body);
  });

  it('creates and starts a conversation sequentially', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'demo', status: 'created' }, 201))
      .mockResolvedValueOnce(jsonResponse({ id: 'demo', status: 'starting' }));
    vi.stubGlobal('fetch', fetchMock);
    await executeCli(['--json', 'conversation', 'create', 'demo', '--agent-type', 'opencode-k8s', '--start']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const createInit = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(createInit.body))).toEqual({ id: 'demo', agentType: 'opencode-k8s' });
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/conversations/demo/start');
  });

  it('reads message text from a file', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await executeCli(['message', 'send', 'demo', '--file', 'package.json', '--json']);
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as { text: string };
    expect(body.text).toContain('@luberserker0v0/agent-orchestrator');
  });

  it('requires confirmation for destructive conversation deletion', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await executeCli(['conversation', 'delete', 'demo']);
    expect(process.exitCode).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['conversation', 'delete', 'demo', '--confirm'],
    ['session', 'delete', 'demo', 'ses', '--confirm'],
  ])('executes confirmed deletion: %s', async (...args) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(undefined, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await executeCli(['--json', ...args]);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });

  it('deduplicates cleanup targets and reports partial execution as failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: 'partial', artifacts: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await executeCli(['--json', 'cleanup', 'run', '--target', 'logs', '--target', 'logs', '--confirm']);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ targets: ['logs'], confirm: true });
    expect(process.exitCode).toBe(1);
  });

  it('maps authorization failures to exit code 3', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'FORBIDDEN', message: 'denied' } }, 403)));
    await executeCli(['conversation', 'list']);
    expect(process.exitCode).toBe(3);
  });

  it('uses AOR_API_KEY without printing it', async () => {
    process.env.AOR_API_KEY = 'top-secret';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    await executeCli(['--json', 'conversation', 'list']);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer top-secret');
    expect(output.join('')).not.toContain('top-secret');
  });

  it('validates local config and honors --config for runtime inspection', async () => {
    await executeCli(['--json', '--config', 'config/agentorchestrator.k8s.example.json', 'runtime', 'list']);
    expect(JSON.parse(output.join(''))).toEqual([
      expect.objectContaining({ id: 'opencode-k8s', type: 'kubernetes' }),
    ]);
    output.length = 0;
    await executeCli(['config', 'validate', 'config/agentorchestrator.k8s.example.json', '--json']);
    expect(JSON.parse(output.join(''))).toMatchObject({ valid: true });
  });

  it('returns not-found for an unknown local runtime', async () => {
    await executeCli(['--config', 'config/agentorchestrator.k8s.example.json', 'runtime', 'info', 'missing']);
    expect(process.exitCode).toBe(4);
  });
});
