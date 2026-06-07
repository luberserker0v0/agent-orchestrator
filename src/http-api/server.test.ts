import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createHttpServer, type HttpServer } from './server.js';
import AdmZip from 'adm-zip';

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
      importSkillFromLocal: vi.fn(),
      listSkills: vi.fn(),
      readSkill: vi.fn(),
      getSkillInfo: vi.fn(),
      deleteSkill: vi.fn(),
      writeAgentsMd: vi.fn(),
      readAgentsMd: vi.fn(),
      deleteAgentsMd: vi.fn(),
      resolveWorkspacePath: vi.fn().mockReturnValue('/tmp/workspace'),
      assertQuota: vi.fn(),
    };

    mockConversationState = {
      create: vi.fn().mockImplementation((id: string) => ({ id, status: 'prepared', wsUrl: `ws://localhost/ws/${id}`, ready: false })),
      get: vi.fn().mockReturnValue({ id: 'test-id', status: 'prepared', ready: false }),
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
      startReadyCheck: vi.fn(),
      cancelReadyCheck: vi.fn(),
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
      .send({ id: 'conv-001' });

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

  // ─── Start / Stop / Restart ──────────────────────────────

  it('POST /api/conversations/:id/start returns 200 and transitions to running', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'prepared' });
    mockInstanceManager.createInstance.mockResolvedValue({ id: 'conv-001', port: 30000, sessionId: 'ses_1', process: {}, client: {} });

    const res = await request(server).post('/api/conversations/conv-001/start');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running');
    expect(res.body.port).toBe(30000);
    expect(res.body.sessionId).toBe('ses_1');
    expect(mockInstanceManager.createInstance).toHaveBeenCalledWith('conv-001');
  });

  it('POST /api/conversations/:id/start returns 409 when already running', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'running' });

    const res = await request(server).post('/api/conversations/conv-001/start');

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('already starting or running');
  });

  it('POST /api/conversations/:id/start returns 500 on instance creation failure', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'prepared' });
    mockInstanceManager.createInstance.mockRejectedValue(new Error('port allocation failed'));

    const res = await request(server).post('/api/conversations/conv-001/start');

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('port allocation failed');
  });

  // ─── Sessions ───────────────────────────────────────────

  it('POST /api/conversations/:id/sessions creates a session', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'running', ready: true });
    const mockClient = { createSession: vi.fn().mockResolvedValue({ id: 'ses_new', title: 'test', status: 'active', created_at: '2026-01-01', updated_at: '2026-01-01' }) };
    mockInstanceManager.getInstance.mockReturnValue({ client: mockClient });

    const res = await request(server)
      .post('/api/conversations/conv-001/sessions')
      .send({ title: 'test' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('ses_new');
    expect(mockClient.createSession).toHaveBeenCalledWith({ title: 'test', parentID: undefined });
  });

  it('POST /api/conversations/:id/sessions returns 404 when conversation not found', async () => {
    mockConversationState.has.mockReturnValue(false);

    const res = await request(server).post('/api/conversations/conv-001/sessions').send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Conversation not found');
  });

  it('POST /api/conversations/:id/sessions returns 409 when not running', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'prepared' });

    const res = await request(server).post('/api/conversations/conv-001/sessions').send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('not running');
  });

  it('POST /api/conversations/:id/sessions returns 500 when instance reference lost', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'running', ready: true });
    mockInstanceManager.getInstance.mockReturnValue(undefined);

    const res = await request(server).post('/api/conversations/conv-001/sessions').send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Instance reference lost');
  });

  it('GET /api/conversations/:id/skills lists skills', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockWorkspaceFactory.listSkills.mockReturnValue(['web-search', 'code-review']);

    const res = await request(server).get('/api/conversations/conv-001/skills');

    expect(res.status).toBe(200);
    expect(res.body).toContain('web-search');
    expect(res.body).toContain('code-review');
  });

  it('GET /api/conversations/:id/skills/:name returns skill content', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockWorkspaceFactory.readSkill.mockReturnValue('# web-search\nA skill.');

    const res = await request(server).get('/api/conversations/conv-001/skills/web-search');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('web-search');
    expect(res.body.content).toBe('# web-search\nA skill.');
  });

  it('GET /api/conversations/:id/skills/:name/info returns skill info', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockWorkspaceFactory.getSkillInfo.mockReturnValue({
      name: 'web-search',
      files: ['SKILL.md'],
      totalSize: 1234,
      sha256: 'abc123',
    });

    const res = await request(server).get('/api/conversations/conv-001/skills/web-search/info');

    expect(res.status).toBe(200);
    expect(res.body.sha256).toBe('abc123');
  });

  it('DELETE /api/conversations/:id/skills/:name deletes skill', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'stopped' });

    const res = await request(server).delete('/api/conversations/conv-001/skills/web-search');

    expect(res.status).toBe(204);
    expect(mockWorkspaceFactory.deleteSkill).toHaveBeenCalledWith('conv-001', 'web-search');
  });

  it('DELETE /api/conversations/:id/skills/:name returns 404 when skill not found', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'stopped' });
    mockWorkspaceFactory.deleteSkill.mockImplementation(() => {
      throw new Error('Skill not found: web-search');
    });

    const res = await request(server).delete('/api/conversations/conv-001/skills/web-search');

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Skill not found');
  });

  it('POST /api/conversations/:id/skills/import imports skill', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'stopped' });

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/import')
      .send({ source: 'skills/web-search', name: 'web-search' });

    expect(res.status).toBe(204);
    expect(mockWorkspaceFactory.importSkillFromLocal).toHaveBeenCalledWith('conv-001', 'skills/web-search', 'web-search');
  });

  it('POST /api/conversations/:id/skills/import returns 403 for disallowed source', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'stopped' });
    mockWorkspaceFactory.importSkillFromLocal.mockImplementation(() => {
      throw new Error('Source path not allowed. Must be under one of: /skills');
    });

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/import')
      .send({ source: '../outside', name: 'outside' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Source path not allowed');
  });

  it('POST /api/conversations/:id/skills/import returns 404 for missing source', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'stopped' });
    mockWorkspaceFactory.importSkillFromLocal.mockImplementation(() => {
      throw new Error('Source not found: skills/missing');
    });

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/import')
      .send({ source: 'skills/missing', name: 'missing' });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Source not found');
  });

  it('POST /api/conversations/:id/skills/import returns 413 for quota exceeded', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'stopped' });
    mockWorkspaceFactory.importSkillFromLocal.mockImplementation(() => {
      throw new Error('Workspace quota exceeded. Current: 50000000 bytes, Adding: 1000000 bytes, Limit: 50000000 bytes');
    });

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/import')
      .send({ source: 'skills/huge', name: 'huge' });

    expect(res.status).toBe(413);
    expect(res.body.error).toContain('Workspace quota exceeded');
  });

  it('POST /api/conversations/:id/skills/import returns 400 for invalid name', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'stopped' });

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/import')
      .send({ source: 'skills/web-search', name: 'foo/bar' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid skill name');
    expect(mockWorkspaceFactory.importSkillFromLocal).not.toHaveBeenCalled();
  });

  it('POST /api/conversations/:id/skills/import returns 403 for sibling prefix path skills_evil/', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'stopped' });
    mockWorkspaceFactory.importSkillFromLocal.mockImplementation(() => {
      throw new Error('Source path not allowed. Must be under one of: ...');
    });

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/import')
      .send({ source: 'skills_evil/web-search', name: 'web-search' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Source path not allowed');
  });

  it('POST /api/conversations/:id/skills/import returns 403 for absolute external path', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'stopped' });
    mockWorkspaceFactory.importSkillFromLocal.mockImplementation(() => {
      throw new Error('Source path not allowed. Must be under one of: ...');
    });

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/import')
      .send({ source: 'C:\\temp\\external-skill', name: 'ext' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Source path not allowed');
  });

  it('GET /api/conversations/:id/skills/:name returns 400 for invalid name', async () => {
    mockConversationState.has.mockReturnValue(true);

    const res = await request(server).get('/api/conversations/conv-001/skills/foo%5Cbar');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid skill name');
    expect(mockWorkspaceFactory.readSkill).not.toHaveBeenCalled();
  });

  it('GET /api/conversations/:id/skills/:name/info returns 400 for invalid name', async () => {
    mockConversationState.has.mockReturnValue(true);

    const res = await request(server).get('/api/conversations/conv-001/skills/foo%5Cbar/info');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid skill name');
    expect(mockWorkspaceFactory.getSkillInfo).not.toHaveBeenCalled();
  });

  it('DELETE /api/conversations/:id/skills/:name returns 400 for invalid name', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'stopped' });

    const res = await request(server).delete('/api/conversations/conv-001/skills/foo%5Cbar');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid skill name');
    expect(mockWorkspaceFactory.deleteSkill).not.toHaveBeenCalled();
  });

  it('POST /api/conversations/:id/skills/upload returns 400 for invalid name', async () => {
    mockConversationState.has.mockReturnValue(true);

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/upload?name=foo/bar')
      .set('Content-Type', 'application/zip')
      .send(Buffer.from('PK'));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid skill name');
  });

  it('POST /api/conversations/:id/skills/upload returns 400 for missing name', async () => {
    mockConversationState.has.mockReturnValue(true);

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/upload')
      .set('Content-Type', 'application/zip')
      .send(Buffer.from('PK'));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing name query parameter');
  });

  it('POST /api/conversations/:id/skills/upload returns 400 for missing SKILL.md', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockWorkspaceFactory.resolveWorkspacePath.mockReturnValue('/tmp/workspace');

    const zip = new AdmZip();
    zip.addFile('README.md', Buffer.from('No skill here'));

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/upload?name=bad-skill')
      .set('Content-Type', 'application/zip')
      .send(zip.toBuffer());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Skill archive must contain SKILL.md at the root');
  });

  it('POST /api/conversations/:id/skills/upload returns 400 for Windows drive path', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockWorkspaceFactory.resolveWorkspacePath.mockReturnValue('/tmp/workspace');

    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('# skill'));
    zip.addFile('C:/windows/evil.txt', Buffer.from('evil'));

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/upload?name=slip-skill')
      .set('Content-Type', 'application/zip')
      .send(zip.toBuffer());

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid zip entry path');
  });

  it('POST /api/conversations/:id/skills/upload returns 413 for quota exceeded', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockWorkspaceFactory.resolveWorkspacePath.mockReturnValue('/tmp/workspace');
    mockWorkspaceFactory.assertQuota.mockImplementation(() => {
      throw new Error('Workspace quota exceeded');
    });

    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('# skill'));

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/upload?name=quota-skill')
      .set('Content-Type', 'application/zip')
      .send(zip.toBuffer());

    expect(res.status).toBe(413);
    expect(res.body.error).toBe('Skill archive exceeds workspace quota');
  });

  it('POST /api/conversations/:id/skills/upload succeeds for valid zip', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'stopped' });
    mockWorkspaceFactory.resolveWorkspacePath.mockReturnValue('/tmp/workspace');

    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('# skill'));
    zip.addFile('references/action.md', Buffer.from('action'));

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/upload?name=valid-skill')
      .set('Content-Type', 'application/zip')
      .send(zip.toBuffer());

    expect(res.status).toBe(204);
  });

  it('POST /api/conversations/:id/config writes raw JSON as opencode.json', async () => {
    const res = await request(server)
      .post('/api/conversations/conv-001/config')
      .send({ model: 'test/model', permission: { bash: { '*': 'deny' } } });

    expect(res.status).toBe(204);
    expect(mockWorkspaceFactory.writeConfig).toHaveBeenCalledWith('conv-001', {
      model: 'test/model',
      permission: { bash: { '*': 'deny' } },
    });
  });

  it('POST /api/conversations/:id/config returns 400 for non-object body', async () => {
    const res = await request(server)
      .post('/api/conversations/conv-001/config')
      .set('Content-Type', 'application/json')
      .send('null');

    expect(res.status).toBe(400);
  });

  it('PUT /api/conversations/:id/agent/config writes AGENTS.md', async () => {
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'running' });

    const res = await request(server)
      .put('/api/conversations/conv-001/agent/config')
      .send({ content: '# Project Agents\n\nDesigner agent.' });

    expect(res.status).toBe(204);
    expect(mockWorkspaceFactory.writeAgentsMd).toHaveBeenCalledWith('conv-001', '# Project Agents\n\nDesigner agent.');
    expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith('conv-001', 'AGENTS.md updated');
  });

  it('PUT /api/conversations/:id/agent/config returns 400 for missing content', async () => {
    const res = await request(server)
      .put('/api/conversations/conv-001/agent/config')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('content');
  });

  it('GET /api/conversations/:id/agent/config reads AGENTS.md', async () => {
    mockWorkspaceFactory.readAgentsMd.mockReturnValue('# Agents');

    const res = await request(server)
      .get('/api/conversations/conv-001/agent/config');

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('# Agents');
  });

  it('GET /api/conversations/:id/agent/config returns 404 when missing', async () => {
    mockWorkspaceFactory.readAgentsMd.mockImplementation(() => { throw new Error('AGENTS.md not found'); });

    const res = await request(server)
      .get('/api/conversations/conv-001/agent/config');

    expect(res.status).toBe(404);
  });

  it('DELETE /api/conversations/:id/agent/config deletes AGENTS.md', async () => {
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'running' });

    const res = await request(server)
      .delete('/api/conversations/conv-001/agent/config');

    expect(res.status).toBe(204);
    expect(mockWorkspaceFactory.deleteAgentsMd).toHaveBeenCalledWith('conv-001');
    expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith('conv-001', 'AGENTS.md deleted');
  });

  it('POST /api/conversations/:id/message sends text and returns result', async () => {
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'running', ready: true });
    const sendPrompt = vi.fn().mockResolvedValue({
      info: { id: 'msg_1', role: 'assistant', session_id: 'ses_1', created_at: '', updated_at: '' },
      parts: [{ type: 'text', text: 'Hello back!' }],
    });
    mockInstanceManager.getInstance.mockReturnValue({ sessionId: 'ses_1', client: { sendPrompt } });

    const res = await request(server)
      .post('/api/conversations/conv-001/message')
      .send({ text: 'Hello' });

    expect(res.status).toBe(200);
    expect(res.body.messageId).toBe('msg_1');
    expect(res.body.text).toBe('Hello back!');
    expect(res.body.parts).toEqual([{ type: 'text', text: 'Hello back!' }]);
    expect(sendPrompt).toHaveBeenCalledWith('ses_1', {
      model: undefined,
      agent: undefined,
      parts: [{ type: 'text', text: 'Hello' }],
    });
  });

  it('POST /api/conversations/:id/message passes model and agent to OpenCode', async () => {
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'running', ready: true });
    const sendPrompt = vi.fn().mockResolvedValue({
      info: { id: 'msg_2', role: 'assistant', session_id: 'ses_1', created_at: '', updated_at: '' },
      parts: [{ type: 'text', text: 'Done' }],
    });
    mockInstanceManager.getInstance.mockReturnValue({ sessionId: 'ses_1', client: { sendPrompt } });

    const res = await request(server)
      .post('/api/conversations/conv-001/message')
      .send({ text: 'Build it', model: 'google/gemini-2.0', agent: 'build' });

    expect(res.status).toBe(200);
    expect(sendPrompt).toHaveBeenCalledWith('ses_1', {
      model: { providerID: 'google', modelID: 'gemini-2.0' },
      agent: 'build',
      parts: [{ type: 'text', text: 'Build it' }],
    });
  });

  it('POST /api/conversations/:id/message returns 400 for missing text', async () => {
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'running', ready: true });

    const res = await request(server)
      .post('/api/conversations/conv-001/message')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('text');
  });

  it('POST /api/conversations/:id/message returns 409 when not running', async () => {
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'prepared' });

    const res = await request(server)
      .post('/api/conversations/conv-001/message')
      .send({ text: 'Hi' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('not running');
  });

  it('POST /api/conversations/:id/message returns 500 when instance reference lost', async () => {
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'running', ready: true });
    mockInstanceManager.getInstance.mockReturnValue(undefined);

    const res = await request(server)
      .post('/api/conversations/conv-001/message')
      .send({ text: 'Hi' });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Instance reference lost');
  });

  it('closeWebSockets does not throw', () => {
    expect(() => httpServer.closeWebSockets()).not.toThrow();
  });
});
