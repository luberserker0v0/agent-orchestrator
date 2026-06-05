import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createHttpServer, type HttpServer } from './server.js';

describe('HTTP API Server', () => {
  let httpServer: HttpServer;
  let server: HttpServer['server'];
  let mockInstanceManager: any;
  let mockWorkspaceFactory: any;
  let mockConversationState: any;
  let mockListModels: any;

  beforeEach(() => {
    mockInstanceManager = {
      createInstance: vi.fn(),
      destroyInstance: vi.fn(),
      listInstances: vi.fn(),
      getInstance: vi.fn(),
    };

    mockWorkspaceFactory = {
      create: vi.fn(),
      destroy: vi.fn(),
      ensure: vi.fn(),
      hasWorkspace: vi.fn(),
      writeConfig: vi.fn(),
      readConfig: vi.fn(),
      writeAgent: vi.fn(),
      readAgent: vi.fn(),
      deleteAgent: vi.fn(),
      listAgents: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn(),
      listFiles: vi.fn(),
      deleteFile: vi.fn(),
      copyFromLocal: vi.fn(),
      getWorkspaceSize: vi.fn(),
    };

    mockConversationState = {
      create: vi.fn().mockImplementation((id: string) => ({ id, status: 'prepared', wsUrl: `ws://localhost/ws/${id}` })),
      get: vi.fn().mockReturnValue({ id: 'test-id', status: 'prepared' }),
      has: vi.fn().mockReturnValue(true),
      list: vi.fn().mockReturnValue([]),
      remove: vi.fn(),
      transition: vi.fn(),
      markNeedsRestart: vi.fn(),
      clearNeedsRestart: vi.fn(),
      setInstanceInfo: vi.fn(),
      setRunningInstance: vi.fn(),
      removeRunningInstance: vi.fn(),
      getRecentEvents: vi.fn().mockReturnValue([]),
      subscribe: vi.fn().mockReturnValue(() => {}),
      emitEvent: vi.fn(),
    };

    mockListModels = vi.fn();

    httpServer = createHttpServer(
      { port: 0, host: '127.0.0.1', shutdownTimeoutMs: 15000 },
      { heartbeatIntervalMs: 30000, idleTimeoutMs: 600000 },
      mockInstanceManager,
      mockWorkspaceFactory,
      mockConversationState,
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

  it('POST /api/conversations prepares workspace', async () => {
    mockConversationState.has.mockReturnValue(false);

    const res = await request(server)
      .post('/api/conversations')
      .send({ id: 'conv-001', model: 'anthropic/claude', agent: 'build' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('conv-001');
    expect(res.body.status).toBe('prepared');
    expect(res.body.wsUrl).toContain('/ws/conv-001');
  });

  it('POST /api/conversations returns 500 on workspace failure', async () => {
    mockConversationState.has.mockReturnValue(false);
    mockWorkspaceFactory.create.mockImplementation(() => {
      throw new Error('disk full');
    });

    const res = await request(server)
      .post('/api/conversations')
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('disk full');
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

  it('DELETE /api/conversations/:id destroys instance and workspace', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ status: 'stopped' });

    const res = await request(server).delete('/api/conversations/conv-001');

    expect(res.status).toBe(204);
    // When stopped, instance should already be destroyed, so destroyInstance is not called again
    expect(mockInstanceManager.destroyInstance).not.toHaveBeenCalled();
    expect(mockWorkspaceFactory.destroy).toHaveBeenCalledWith('conv-001');
    expect(mockConversationState.remove).toHaveBeenCalledWith('conv-001');
  });

  it('DELETE /api/conversations/:id returns 404 when not found', async () => {
    mockConversationState.has.mockReturnValue(false);

    const res = await request(server).delete('/api/conversations/conv-001');

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Conversation not found');
  });

  it('GET /api/conversations lists conversations', async () => {
    mockConversationState.list.mockReturnValue([
      { id: 'conv-001', status: 'prepared', needsRestart: false, port: undefined, sessionId: undefined, wsUrl: 'ws://localhost:8080/ws/conv-001', createdAt: Date.now(), updatedAt: Date.now() },
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
