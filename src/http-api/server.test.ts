import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createHttpServer, type HttpServer } from './server.js';

describe('HTTP API Server', () => {
  let httpServer: HttpServer;
  let server: HttpServer['server'];
  let mockInstanceManager: any;
  let mockListModels: any;

  beforeEach(() => {
    mockInstanceManager = {
      createInstance: vi.fn(),
      destroyInstance: vi.fn(),
      listInstances: vi.fn(),
      getInstance: vi.fn(),
    };

    mockListModels = vi.fn();

    httpServer = createHttpServer(
      { port: 0, host: '127.0.0.1', shutdownTimeoutMs: 15000 },
      { heartbeatIntervalMs: 30000, idleTimeoutMs: 600000 },
      mockInstanceManager,
      { opencodeBinary: 'opencode', maxInstances: 10, idleTimeoutMs: 600000, idleSweepIntervalMs: 60000, portRange: { start: 30000, end: 30100 }, healthCheck: { retries: 10, intervalMs: 500 } }
    );
    server = httpServer.server;
  });

  afterEach(() => {
    server.close();
    vi.clearAllMocks();
  });

  it('GET /health returns 200', async () => {
    const res = await request(server).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.uptime).toBeGreaterThan(0);
  });

  it('POST /api/conversations creates instance', async () => {
    mockInstanceManager.createInstance.mockResolvedValue({
      id: 'conv-001',
      port: 30000,
      sessionId: 'ses_1',
      defaultModel: 'anthropic/claude',
      defaultAgent: 'build',
    });

    const res = await request(server)
      .post('/api/conversations')
      .send({ id: 'conv-001', model: 'anthropic/claude', agent: 'build' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('conv-001');
    expect(res.body.port).toBe(30000);
    expect(res.body.sessionId).toBe('ses_1');
    expect(res.body.wsUrl).toContain('/ws/conv-001');
  });

  it('POST /api/conversations returns 500 on failure', async () => {
    mockInstanceManager.createInstance.mockRejectedValue(new Error('No ports'));

    const res = await request(server)
      .post('/api/conversations')
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('No ports');
  });

  it('GET /api/models lists models', async () => {
    vi.doMock('../opencode-cli/models.js', () => ({
      listModels: mockListModels,
    }));
    mockListModels.mockResolvedValue([
      { id: 'anthropic/claude', provider: 'anthropic', model: 'claude' },
    ]);

    const res = await request(server).get('/api/models');
    expect(res.status).toBe(200);
  });

  it('DELETE /api/conversations/:id destroys instance', async () => {
    mockInstanceManager.destroyInstance.mockResolvedValue(undefined);

    const res = await request(server).delete('/api/conversations/conv-001');

    expect(res.status).toBe(204);
    expect(mockInstanceManager.destroyInstance).toHaveBeenCalledWith('conv-001');
  });

  it('DELETE /api/conversations/:id returns 500 on failure', async () => {
    mockInstanceManager.destroyInstance.mockRejectedValue(new Error('Not found'));

    const res = await request(server).delete('/api/conversations/conv-001');

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Not found');
  });

  it('GET /api/conversations lists instances', async () => {
    mockInstanceManager.listInstances.mockReturnValue([
      { id: 'conv-001', port: 30000, lastUsedAt: Date.now(), isReady: true },
    ]);

    const res = await request(server).get('/api/conversations');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('conv-001');
  });

  it('sets CORS headers', async () => {
    const res = await request(server).options('/health');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('OPTIONS preflight returns 200', async () => {
    const res = await request(server)
      .options('/api/conversations')
      .set('Origin', 'http://example.com');

    expect(res.status).toBe(200);
  });

  it('waitForRequests resolves immediately when no active requests', async () => {
    await expect(httpServer.waitForRequests(1000)).resolves.toBeUndefined();
  });

  it('waitForRequests resolves after active requests finish', async () => {
    mockInstanceManager.createInstance.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ id: 'conv-001', port: 30000, sessionId: 'ses_1' }), 200))
    );

    const reqPromise = request(server).post('/api/conversations').send({});

    // Give the request time to start
    await new Promise((resolve) => setTimeout(resolve, 50));

    const waitPromise = httpServer.waitForRequests(2000);

    // Finish the request
    await reqPromise;
    await waitPromise;
  });

  it('waitForRequests resolves on timeout even if requests are still active', async () => {
    mockInstanceManager.createInstance.mockImplementation(() => new Promise(() => {}));

    const reqPromise = request(server).post('/api/conversations').send({});

    // Give the request time to start
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(httpServer.waitForRequests(100)).resolves.toBeUndefined();

    // Clean up the hanging request by closing the server
    server.close();
    await reqPromise.catch(() => {});
  });

  it('closeWebSockets does not throw', () => {
    expect(() => httpServer.closeWebSockets()).not.toThrow();
  });
});
