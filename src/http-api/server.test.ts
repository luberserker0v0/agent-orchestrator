import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createHttpServer } from './server.js';

describe('HTTP API Server', () => {
  let server: ReturnType<typeof createHttpServer>;
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

    server = createHttpServer(
      { port: 0, host: '127.0.0.1' },
      { heartbeatIntervalMs: 30000, idleTimeoutMs: 600000 },
      mockInstanceManager,
      { opencodeBinary: 'opencode' }
    );
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
});
