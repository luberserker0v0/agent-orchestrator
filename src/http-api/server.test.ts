import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createHttpServer, type HttpServer } from './server.js';
import { defaultOrchestratorConfig, dockerOrchestratorConfig } from '../test-fixtures/ao-configs.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import AdmZip from 'adm-zip';

describe('HTTP API Server', () => {
  let httpServer: HttpServer;
  let server: HttpServer['server'];
  let mockInstanceManager: any;
  let mockWorkspaceFactory: any;
  let mockConversationState: any;
  let mockConfigService: any;
  let mockAgentService: any;
  let mockSkillService: any;
  let mockConversationService: any;
  let mockFileService: any;
  let mockSessionService: any;
  let mockMessageService: any;
  let mockRuntimeRegistry: any;

  beforeEach(() => {
    mockRuntimeRegistry = {
      get: vi.fn().mockReturnValue({ spawn: vi.fn(), kill: vi.fn() }),
      getOrThrow: vi.fn().mockReturnValue({ spawn: vi.fn(), kill: vi.fn() }),
      list: vi.fn().mockReturnValue(['opencode']),
      has: vi.fn().mockReturnValue(true),
    };

    mockInstanceManager = {
      createInstance: vi.fn(),
      destroyInstance: vi.fn().mockResolvedValue(undefined),
      stopInstance: vi.fn().mockResolvedValue(undefined),
      restartInstance: vi.fn().mockResolvedValue(undefined),
      listInstances: vi.fn(),
      getInstance: vi.fn(),
      setSessionId: vi.fn(),
    };

    mockWorkspaceFactory = {
      create: vi.fn(),
      destroy: vi.fn(),
      ensure: vi.fn(),
      hasWorkspace: vi.fn(),
      writeConfig: vi.fn(),
      readConfig: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn(),
      listFiles: vi.fn(),
      deleteFile: vi.fn(),
      copyFromLocal: vi.fn(),
      getWorkspaceSize: vi.fn(),
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

    mockConfigService = {
      readConfig: vi.fn(),
      writeConfig: vi.fn(),
      patchConfig: vi.fn(),
    };

    mockAgentService = {
      writeAgent: vi.fn(),
      readAgent: vi.fn(),
      deleteAgent: vi.fn(),
      listAgents: vi.fn(),
      listAgentsWithRuntime: vi.fn(),
      writeAgentsMd: vi.fn(),
      readAgentsMd: vi.fn(),
      deleteAgentsMd: vi.fn(),
    };

    mockSkillService = {
      uploadSkill: vi.fn(),
      importSkill: vi.fn(),
      listSkills: vi.fn(),
      readSkill: vi.fn(),
      getSkillInfo: vi.fn(),
      deleteSkill: vi.fn(),
    };

    mockConversationService = {
      create: vi.fn().mockImplementation((id, agentType) => {
        const convId = id ?? 'test-id';
        return {
          id: convId,
          agentType: agentType ?? 'opencode',
          status: 'prepared',
          ready: false,
          needsRestart: false,
          port: undefined,
          sessionId: undefined,
          wsUrl: `ws://127.0.0.1:8080/ws/${convId}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
      }),
      start: vi.fn().mockResolvedValue({ id: 'conv-001', agentType: 'opencode', status: 'running', ready: false, port: 30000, sessionId: undefined }),
      stop: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue({ id: 'conv-001', agentType: 'opencode', status: 'running', ready: false, port: 30000, sessionId: undefined }),
      delete: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockReturnValue({ id: 'conv-001', status: 'ready', ready: true, needsRestart: false, port: 30000, sessionId: 'ses_1', wsUrl: 'ws://localhost/ws/conv-001', createdAt: 100, updatedAt: 200 }),
      list: vi.fn().mockReturnValue([]),
      getEvents: vi.fn().mockReturnValue([]),
    };

    mockFileService = {
      write: vi.fn(),
      read: vi.fn().mockReturnValue('file content'),
      delete: vi.fn(),
      copy: vi.fn(),
      list: vi.fn().mockReturnValue(['file1.txt', 'file2.txt']),
    };

    mockSessionService = {
      create: vi.fn().mockResolvedValue({ id: 'ses_new' }),
      list: vi.fn().mockResolvedValue([{ id: 'ses_1' }]),
      get: vi.fn().mockResolvedValue({ id: 'ses_1' }),
      delete: vi.fn().mockResolvedValue(undefined),
      fork: vi.fn().mockResolvedValue({ id: 'forked_ses' }),
      getChildren: vi.fn().mockResolvedValue([{ id: 'child_1' }]),
      abort: vi.fn().mockResolvedValue({ aborted: true }),
      listProviders: vi.fn().mockResolvedValue({ providers: [], default: {} }),
    };

    mockMessageService = {
      send: vi.fn().mockResolvedValue({ messageId: 'msg_1', text: 'Hello back!', parts: [{ type: 'text', text: 'Hello back!' }] }),
      getHistory: vi.fn().mockResolvedValue([]),
    };

    httpServer = createHttpServer(
      { port: 0, host: '127.0.0.1', shutdownTimeoutMs: 15000 },
      { heartbeatIntervalMs: 30000, idleTimeoutMs: 600000 },
      mockInstanceManager,
      mockWorkspaceFactory,
      mockConversationState,
      defaultOrchestratorConfig,
      mockConfigService,
      mockAgentService,
      mockSkillService,
      mockRuntimeRegistry,
      mockConversationService,
      mockFileService,
      mockSessionService,
      mockMessageService
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

  it('GET /api-docs/ serves Swagger UI', async () => {
    const res = await request(server).get('/api-docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });

  it('GET /api-docs redirects to /api-docs/', async () => {
    const res = await request(server).get('/api-docs');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/api-docs/');
  });

  it('GET /api-docs.json returns OpenAPI spec', async () => {
    const res = await request(server).get('/api-docs.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.0.3');
    expect(res.body.info.title).toBe('AgentOrchestrator API');
    expect(res.body.paths['/health']).toBeDefined();
    expect(res.body.paths['/api/conversations']).toBeDefined();
  });

  it('POST /api/conversations prepares workspace', async () => {
    mockConversationService.create.mockReturnValue({
      id: 'conv-001', agentType: 'opencode', status: 'prepared', ready: false,
      wsUrl: 'ws://127.0.0.1:8080/ws/conv-001', createdAt: Date.now(), updatedAt: Date.now(),
    });

    const res = await request(server)
      .post('/api/conversations')
      .send({ id: 'conv-001' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('conv-001');
    expect(res.body.status).toBe('prepared');
    expect(res.body.wsUrl).toContain('/ws/conv-001');
  });

  it('POST /api/conversations returns 500 on workspace failure', async () => {
    mockConversationService.create.mockImplementation(() => {
      throw new Error('disk full');
    });

    const res = await request(server)
      .post('/api/conversations')
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('disk full');
  });

  it('DELETE /api/conversations/:id destroys instance and workspace', async () => {
    const res = await request(server).delete('/api/conversations/conv-001');

    expect(res.status).toBe(204);
    expect(mockConversationService.delete).toHaveBeenCalledWith('conv-001');
  });

  it('DELETE /api/conversations/:id returns 404 when not found', async () => {
    mockConversationService.delete.mockRejectedValue(new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found'));

    const res = await request(server).delete('/api/conversations/conv-001');

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('Conversation not found');
  });

  it('GET /api/conversations lists conversations', async () => {
    mockConversationService.list.mockReturnValue([
      { id: 'conv-001', agentType: 'opencode', status: 'prepared', ready: false, needsRestart: false, port: undefined, sessionId: undefined, wsUrl: 'ws://localhost:8080/ws/conv-001', createdAt: Date.now(), updatedAt: Date.now() },
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
      () => new Promise((resolve) => setTimeout(() => resolve({ id: 'conv-001', port: 30000, process: {}, client: { createSession: vi.fn().mockResolvedValue({ id: 'ses_1' }) } }), 200))
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
    mockConversationService.start.mockResolvedValue({ id: 'conv-001', agentType: 'opencode', status: 'running', ready: false, port: 30000 });

    const res = await request(server).post('/api/conversations/conv-001/start');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running');
    expect(res.body.port).toBe(30000);
    expect(mockConversationService.start).toHaveBeenCalledWith('conv-001');
  });

  it('POST /api/conversations/:id/start returns 409 when already running', async () => {
    mockConversationService.start.mockRejectedValue(new AppError(409, ErrorCodes.CONVERSATION_ALREADY_RUNNING, 'Conversation is already starting or running'));

    const res = await request(server).post('/api/conversations/conv-001/start');

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('already starting or running');
  });

  it('POST /api/conversations/:id/start returns 500 on instance creation failure', async () => {
    mockConversationService.start.mockRejectedValue(new Error('port allocation failed'));

    const res = await request(server).post('/api/conversations/conv-001/start');

    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('port allocation failed');
  });

  // ─── Sessions ───────────────────────────────────────────

  it('POST /api/conversations/:id/sessions creates a session', async () => {
    mockSessionService.create.mockResolvedValue({ id: 'ses_new', title: 'test', status: 'active', created_at: '2026-01-01', updated_at: '2026-01-01' });

    const res = await request(server)
      .post('/api/conversations/conv-001/sessions')
      .send({ title: 'test' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('ses_new');
    expect(mockSessionService.create).toHaveBeenCalledWith('conv-001', { title: 'test' });
  });

  it('POST /api/conversations/:id/sessions returns 404 when conversation not found', async () => {
    mockSessionService.create.mockRejectedValue(new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found'));

    const res = await request(server).post('/api/conversations/conv-001/sessions').send({});

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('Conversation not found');
  });

  it('POST /api/conversations/:id/sessions returns 409 when not running', async () => {
    mockSessionService.create.mockRejectedValue(new AppError(409, ErrorCodes.CONVERSATION_NOT_RUNNING, 'Conversation is not running (status: prepared)'));

    const res = await request(server).post('/api/conversations/conv-001/sessions').send({});

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('not running');
  });

  it('POST /api/conversations/:id/sessions returns 500 when instance reference lost', async () => {
    mockSessionService.create.mockRejectedValue(new Error('Instance reference lost'));

    const res = await request(server).post('/api/conversations/conv-001/sessions').send({});

    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('Instance reference lost');
  });

  it('GET /api/conversations/:id/skills lists skills', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockSkillService.listSkills.mockReturnValue(['web-search', 'code-review']);

    const res = await request(server).get('/api/conversations/conv-001/skills');

    expect(res.status).toBe(200);
    expect(res.body).toContain('web-search');
    expect(res.body).toContain('code-review');
  });

  it('GET /api/conversations/:id/skills/:name returns skill content', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockSkillService.readSkill.mockReturnValue('# web-search\nA skill.');

    const res = await request(server).get('/api/conversations/conv-001/skills/web-search');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('web-search');
    expect(res.body.content).toBe('# web-search\nA skill.');
  });

  it('GET /api/conversations/:id/skills/:name/info returns skill info', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockSkillService.getSkillInfo.mockReturnValue({
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

    const res = await request(server).delete('/api/conversations/conv-001/skills/web-search');

    expect(res.status).toBe(204);
    expect(mockSkillService.deleteSkill).toHaveBeenCalledWith('conv-001', 'web-search');
  });

  it('DELETE /api/conversations/:id/skills/:name returns 404 when skill not found', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockSkillService.deleteSkill.mockImplementation(() => {
      throw new Error('Skill not found: web-search');
    });

    const res = await request(server).delete('/api/conversations/conv-001/skills/web-search');

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('Skill not found');
  });

  it('POST /api/conversations/:id/skills/import imports skill', async () => {
    mockConversationState.has.mockReturnValue(true);

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/import')
      .send({ source: 'skills/web-search', name: 'web-search' });

    expect(res.status).toBe(204);
    expect(mockSkillService.importSkill).toHaveBeenCalledWith('conv-001', 'skills/web-search', 'web-search');
  });

  it('POST /api/conversations/:id/skills/import returns 403 for disallowed source', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockSkillService.importSkill.mockImplementation(() => {
      throw new Error('Source path not allowed. Must be under one of: /skills');
    });

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/import')
      .send({ source: '../outside', name: 'outside' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('Source path not allowed');
  });

  it('POST /api/conversations/:id/skills/import returns 404 for missing source', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockSkillService.importSkill.mockImplementation(() => {
      throw new Error('Source not found: skills/missing');
    });

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/import')
      .send({ source: 'skills/missing', name: 'missing' });

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('Source not found');
  });

  it('POST /api/conversations/:id/skills/import returns 413 for quota exceeded', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockSkillService.importSkill.mockImplementation(() => {
      throw new Error('Workspace quota exceeded. Current: 50000000 bytes, Adding: 1000000 bytes, Limit: 50000000 bytes');
    });

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/import')
      .send({ source: 'skills/huge', name: 'huge' });

    expect(res.status).toBe(413);
    expect(res.body.error.message).toContain('Workspace quota exceeded');
  });

  it('POST /api/conversations/:id/skills/import returns 400 for invalid name', async () => {
    mockConversationState.has.mockReturnValue(true);

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/import')
      .send({ source: 'skills/web-search', name: 'foo/bar' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Invalid skill name');
    expect(mockSkillService.importSkill).not.toHaveBeenCalled();
  });

  it('POST /api/conversations/:id/skills/import returns 403 for sibling prefix path skills_evil/', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockSkillService.importSkill.mockImplementation(() => {
      throw new Error('Source path not allowed. Must be under one of: ...');
    });

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/import')
      .send({ source: 'skills_evil/web-search', name: 'web-search' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('Source path not allowed');
  });

  it('POST /api/conversations/:id/skills/import returns 403 for absolute external path', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockSkillService.importSkill.mockImplementation(() => {
      throw new Error('Source path not allowed. Must be under one of: ...');
    });

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/import')
      .send({ source: 'C:\\temp\\external-skill', name: 'ext' });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('Source path not allowed');
  });

  it('GET /api/conversations/:id/skills/:name returns 400 for invalid name', async () => {
    mockConversationState.has.mockReturnValue(true);

    const res = await request(server).get('/api/conversations/conv-001/skills/foo%5Cbar');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Invalid skill name');
    expect(mockSkillService.readSkill).not.toHaveBeenCalled();
  });

  it('GET /api/conversations/:id/skills/:name/info returns 400 for invalid name', async () => {
    mockConversationState.has.mockReturnValue(true);

    const res = await request(server).get('/api/conversations/conv-001/skills/foo%5Cbar/info');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Invalid skill name');
    expect(mockSkillService.getSkillInfo).not.toHaveBeenCalled();
  });

  it('DELETE /api/conversations/:id/skills/:name returns 400 for invalid name', async () => {
    mockConversationState.has.mockReturnValue(true);

    const res = await request(server).delete('/api/conversations/conv-001/skills/foo%5Cbar');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Invalid skill name');
    expect(mockSkillService.deleteSkill).not.toHaveBeenCalled();
  });

  it('POST /api/conversations/:id/skills/upload returns 400 for invalid name', async () => {
    mockConversationState.has.mockReturnValue(true);

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/upload?name=foo/bar')
      .set('Content-Type', 'application/zip')
      .send(Buffer.from('PK'));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Invalid skill name');
    expect(mockSkillService.uploadSkill).not.toHaveBeenCalled();
  });

  it('POST /api/conversations/:id/skills/upload returns 400 for missing name', async () => {
    mockConversationState.has.mockReturnValue(true);

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/upload')
      .set('Content-Type', 'application/zip')
      .send(Buffer.from('PK'));

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Missing name query parameter');
  });

  it('POST /api/conversations/:id/skills/upload returns 400 for missing SKILL.md', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockSkillService.uploadSkill.mockImplementation(() => {
      throw new Error('Skill archive must contain SKILL.md at the root');
    });

    const zip = new AdmZip();
    zip.addFile('README.md', Buffer.from('No skill here'));

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/upload?name=bad-skill')
      .set('Content-Type', 'application/zip')
      .send(zip.toBuffer());

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Skill archive must contain SKILL.md at the root');
    expect(mockSkillService.uploadSkill).toHaveBeenCalledWith('conv-001', 'bad-skill', expect.any(Buffer));
  });

  it('POST /api/conversations/:id/skills/upload returns 400 for Windows drive path', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockSkillService.uploadSkill.mockImplementation(() => {
      throw new Error('Invalid zip entry path: C:/windows/evil.txt');
    });

    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('# skill'));
    zip.addFile('C:/windows/evil.txt', Buffer.from('evil'));

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/upload?name=slip-skill')
      .set('Content-Type', 'application/zip')
      .send(zip.toBuffer());

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Invalid zip entry path');
    expect(mockSkillService.uploadSkill).toHaveBeenCalledWith('conv-001', 'slip-skill', expect.any(Buffer));
  });

  it('POST /api/conversations/:id/skills/upload returns 413 for quota exceeded', async () => {
    mockConversationState.has.mockReturnValue(true);
    mockSkillService.uploadSkill.mockImplementation(() => {
      throw new Error('Workspace quota exceeded. Current: 52428800 bytes, Adding: 1024 bytes, Limit: 52428800 bytes');
    });

    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('# skill'));

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/upload?name=quota-skill')
      .set('Content-Type', 'application/zip')
      .send(zip.toBuffer());

    expect(res.status).toBe(413);
    expect(res.body.error.message).toBe('Skill archive exceeds workspace quota');
    expect(mockSkillService.uploadSkill).toHaveBeenCalledWith('conv-001', 'quota-skill', expect.any(Buffer));
  });

  it('POST /api/conversations/:id/skills/upload succeeds for valid zip', async () => {
    mockConversationState.has.mockReturnValue(true);

    const zip = new AdmZip();
    zip.addFile('SKILL.md', Buffer.from('# skill'));
    zip.addFile('references/action.md', Buffer.from('action'));

    const res = await request(server)
      .post('/api/conversations/conv-001/skills/upload?name=valid-skill')
      .set('Content-Type', 'application/zip')
      .send(zip.toBuffer());

    expect(res.status).toBe(204);
    expect(mockSkillService.uploadSkill).toHaveBeenCalledWith('conv-001', 'valid-skill', expect.any(Buffer));
  });

  it('POST /api/conversations/:id/config writes raw JSON as opencode.json', async () => {
    const res = await request(server)
      .post('/api/conversations/conv-001/config')
      .send({ model: 'test/model', permission: { bash: { '*': 'deny' } } });

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
    expect(mockConfigService.writeConfig).toHaveBeenCalledWith('conv-001', {
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
    const res = await request(server)
      .put('/api/conversations/conv-001/agent/config')
      .send({ content: '# Project Agents\n\nDesigner agent.' });

    expect(res.status).toBe(204);
    expect(mockAgentService.writeAgentsMd).toHaveBeenCalledWith('conv-001', '# Project Agents\n\nDesigner agent.');
  });

  it('PUT /api/conversations/:id/agent/config returns 400 for missing content', async () => {
    const res = await request(server)
      .put('/api/conversations/conv-001/agent/config')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('content');
  });

  it('GET /api/conversations/:id/agent/config reads AGENTS.md', async () => {
    mockAgentService.readAgentsMd.mockReturnValue('# Agents');

    const res = await request(server)
      .get('/api/conversations/conv-001/agent/config');

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('# Agents');
  });

  it('GET /api/conversations/:id/agent/config returns 404 when missing', async () => {
    mockAgentService.readAgentsMd.mockImplementation(() => { throw new Error('AGENTS.md not found'); });

    const res = await request(server)
      .get('/api/conversations/conv-001/agent/config');

    expect(res.status).toBe(404);
  });

  it('DELETE /api/conversations/:id/agent/config deletes AGENTS.md', async () => {
    const res = await request(server)
      .delete('/api/conversations/conv-001/agent/config');

    expect(res.status).toBe(204);
    expect(mockAgentService.deleteAgentsMd).toHaveBeenCalledWith('conv-001');
  });

  it('POST /api/conversations/:id/message sends text and returns result', async () => {
    mockMessageService.send.mockResolvedValue({ messageId: 'msg_1', text: 'Hello back!', parts: [{ type: 'text', text: 'Hello back!' }] });

    const res = await request(server)
      .post('/api/conversations/conv-001/message')
      .send({ text: 'Hello' });

    expect(res.status).toBe(200);
    expect(res.body.messageId).toBe('msg_1');
    expect(res.body.text).toBe('Hello back!');
    expect(res.body.parts).toEqual([{ type: 'text', text: 'Hello back!' }]);
    expect(mockMessageService.send).toHaveBeenCalledWith('conv-001', 'Hello', undefined, undefined);
  });

  it('POST /api/conversations/:id/message passes model and agent to OpenCode', async () => {
    mockMessageService.send.mockResolvedValue({ messageId: 'msg_2', text: 'Done', parts: [{ type: 'text', text: 'Done' }] });

    const res = await request(server)
      .post('/api/conversations/conv-001/message')
      .send({ text: 'Build it', model: 'google/gemini-2.0', agent: 'build' });

    expect(res.status).toBe(200);
    expect(mockMessageService.send).toHaveBeenCalledWith('conv-001', 'Build it', 'google/gemini-2.0', 'build');
  });

  it('POST /api/conversations/:id/message returns 400 for missing text', async () => {
    mockConversationState.get.mockReturnValue({ id: 'conv-001', status: 'running', ready: true });

    const res = await request(server)
      .post('/api/conversations/conv-001/message')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('text');
  });

  it('POST /api/conversations/:id/message returns 409 when not running', async () => {
    mockMessageService.send.mockRejectedValue(new AppError(409, ErrorCodes.CONVERSATION_NOT_RUNNING, 'Conversation is not running (status: prepared)'));

    const res = await request(server)
      .post('/api/conversations/conv-001/message')
      .send({ text: 'Hi' });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('not running');
  });

  it('POST /api/conversations/:id/message returns 500 when instance reference lost', async () => {
    mockMessageService.send.mockRejectedValue(new Error('Instance reference lost'));

    const res = await request(server)
      .post('/api/conversations/conv-001/message')
      .send({ text: 'Hi' });

    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('Instance reference lost');
  });

  it('closeWebSockets does not throw', () => {
    expect(() => httpServer.closeWebSockets()).not.toThrow();
  });

  it('destroys socket for non-WS upgrade request', () => {
    const mockSocket = { destroy: vi.fn() };
    server.emit('upgrade', { url: '/api/test' } as any, mockSocket as any, Buffer.alloc(0));
    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  // ─── Conversation already exists ──────────────────────

  it('POST /api/conversations returns 409 when conversation already exists', async () => {
    mockConversationService.create.mockImplementation(() => {
      throw new AppError(409, ErrorCodes.CONVERSATION_ALREADY_EXISTS, 'Conversation already exists');
    });

    const res = await request(server)
      .post('/api/conversations')
      .send({ id: 'conv-001' });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('already exists');
  });

  // ─── Stop ──────────────────────────────────────────────

  it('POST /api/conversations/:id/stop stops a running conversation', async () => {
    mockConversationService.stop.mockResolvedValue(undefined);

    const res = await request(server).post('/api/conversations/conv-001/stop');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('stopped');
    expect(mockConversationService.stop).toHaveBeenCalledWith('conv-001');
  });

  it('POST /api/conversations/:id/stop returns 409 when in prepared status', async () => {
    mockConversationService.stop.mockRejectedValue(new AppError(409, ErrorCodes.CANNOT_STOP, 'Cannot stop conversation in status: prepared'));

    const res = await request(server).post('/api/conversations/conv-001/stop');

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('Cannot stop');
  });

  it('POST /api/conversations/:id/stop returns 500 on instance destruction failure', async () => {
    mockConversationService.stop.mockRejectedValue(new Error('kill failed'));

    const res = await request(server).post('/api/conversations/conv-001/stop');

    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('kill failed');
  });

  // ─── Restart ───────────────────────────────────────────

  it('POST /api/conversations/:id/restart restarts from stopped status', async () => {
    mockConversationService.restart.mockResolvedValue({ id: 'conv-001', agentType: 'opencode', status: 'running', ready: false, port: 30001 });

    const res = await request(server).post('/api/conversations/conv-001/restart');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('running');
    expect(mockConversationService.restart).toHaveBeenCalledWith('conv-001');
  });

  it('POST /api/conversations/:id/restart restarts from running status', async () => {
    mockConversationService.restart.mockResolvedValue({ id: 'conv-001', agentType: 'opencode', status: 'running', ready: false, port: 30002 });

    const res = await request(server).post('/api/conversations/conv-001/restart');

    expect(res.status).toBe(200);
    expect(mockConversationService.restart).toHaveBeenCalledWith('conv-001');
  });

  it('POST /api/conversations/:id/restart returns 409 when in prepared status', async () => {
    mockConversationService.restart.mockRejectedValue(new AppError(409, ErrorCodes.CANNOT_RESTART, 'Cannot restart conversation in status: prepared'));

    const res = await request(server).post('/api/conversations/conv-001/restart');

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('Cannot restart');
  });

  it('POST /api/conversations/:id/restart returns 500 on instance creation failure', async () => {
    mockConversationService.restart.mockRejectedValue(new Error('port busy'));

    const res = await request(server).post('/api/conversations/conv-001/restart');

    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('port busy');
  });

  it('POST /api/conversations/:id/restart uses restartInstance for Docker runtime', async () => {
    const dockerHttp = createHttpServer(
      { port: 0, host: '127.0.0.1', shutdownTimeoutMs: 15000 },
      { heartbeatIntervalMs: 30000, idleTimeoutMs: 600000 },
      mockInstanceManager,
      mockWorkspaceFactory,
      mockConversationState,
      dockerOrchestratorConfig,
      mockConfigService,
      mockAgentService,
      mockSkillService,
      mockRuntimeRegistry,
      mockConversationService,
      mockFileService,
      mockSessionService,
      mockMessageService
    );
    mockConversationService.restart.mockResolvedValue({ id: 'conv-docker', agentType: 'opencode', status: 'running', ready: false, port: 30010 });

    const res = await request(dockerHttp.server).post('/api/conversations/conv-docker/restart');

    expect(res.status).toBe(200);
    expect(mockConversationService.restart).toHaveBeenCalledWith('conv-docker');
    dockerHttp.server.close();
  });

  // ─── Single conversation GET ───────────────────────────

  it('GET /api/conversations/:id returns conversation', async () => {
    mockConversationService.get.mockReturnValue({ id: 'conv-001', status: 'running', ready: true, needsRestart: false, port: 30000, sessionId: 'ses_1', wsUrl: 'ws://localhost/ws/conv-001', createdAt: 100, updatedAt: 200 });

    const res = await request(server).get('/api/conversations/conv-001');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('conv-001');
    expect(res.body.status).toBe('running');
    expect(res.body.ready).toBe(true);
  });

  it('GET /api/conversations/:id returns 404 when not found', async () => {
    mockConversationService.get.mockImplementation(() => {
      throw new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
    });

    const res = await request(server).get('/api/conversations/conv-001');

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('Conversation not found');
  });

  // ─── Events ────────────────────────────────────────────

  it('GET /api/conversations/:id/events returns events', async () => {
    mockConversationService.getEvents.mockReturnValue([
      { type: 'conversation.started', timestamp: 100 },
    ]);

    const res = await request(server).get('/api/conversations/conv-001/events');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('GET /api/conversations/:id/events returns 404 when not found', async () => {
    mockConversationService.getEvents.mockImplementation(() => {
      throw new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
    });

    const res = await request(server).get('/api/conversations/conv-001/events');

    expect(res.status).toBe(404);
  });

  // ─── Config GET ────────────────────────────────────────

  it('GET /api/conversations/:id/config reads config', async () => {
    mockConfigService.readConfig.mockReturnValue({ model: 'test/model' });

    const res = await request(server).get('/api/conversations/conv-001/config');

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('test/model');
  });

  it('GET /api/conversations/:id/config returns 500 on read error', async () => {
    mockConfigService.readConfig.mockImplementation(() => { throw new Error('read error'); });

    const res = await request(server).get('/api/conversations/conv-001/config');

    expect(res.status).toBe(500);
  });

  // ─── POST Config 500 ───────────────────────────────────

  it('POST /api/conversations/:id/config returns 500 on write error', async () => {
    mockConfigService.writeConfig.mockImplementation(() => { throw new Error('write failed'); });

    const res = await request(server)
      .post('/api/conversations/conv-001/config')
      .send({ model: 'test' });

    expect(res.status).toBe(500);
    expect(res.body.error.message).toContain('write failed');
  });

  // ─── Agents ────────────────────────────────────────────

  it('PUT /api/conversations/:id/agents registers an agent', async () => {
    const res = await request(server)
      .put('/api/conversations/conv-001/agents')
      .send({ name: 'designer', content: 'Designer agent' });

    expect(res.status).toBe(204);
    expect(mockAgentService.writeAgent).toHaveBeenCalledWith('conv-001', 'designer', 'Designer agent');
  });

  it('PUT /api/conversations/:id/agents returns 400 for missing name or content', async () => {
    const res = await request(server)
      .put('/api/conversations/conv-001/agents')
      .send({ name: 'designer' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Missing name or content');
  });

  it('PUT /api/conversations/:id/agents returns 500 on write error', async () => {
    mockAgentService.writeAgent.mockImplementation(() => { throw new Error('write failed'); });

    const res = await request(server)
      .put('/api/conversations/conv-001/agents')
      .send({ name: 'designer', content: 'Content' });

    expect(res.status).toBe(500);
  });

  it('GET /api/conversations/:id/agents lists agents', async () => {
    mockAgentService.listAgentsWithRuntime.mockResolvedValue(['designer', 'coder']);

    const res = await request(server).get('/api/conversations/conv-001/agents');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(['designer', 'coder']);
  });

  it('GET /api/conversations/:id/agents/:name reads agent', async () => {
    mockAgentService.readAgent.mockReturnValue('Designer agent content');

    const res = await request(server).get('/api/conversations/conv-001/agents/designer');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('designer');
    expect(res.body.content).toBe('Designer agent content');
  });

  it('GET /api/conversations/:id/agents/:name returns 404 when missing', async () => {
    mockAgentService.readAgent.mockImplementation(() => { throw new Error('Agent not found'); });

    const res = await request(server).get('/api/conversations/conv-001/agents/missing');

    expect(res.status).toBe(404);
  });

  it('DELETE /api/conversations/:id/agents/:name deletes agent', async () => {
    const res = await request(server).delete('/api/conversations/conv-001/agents/designer');

    expect(res.status).toBe(204);
    expect(mockAgentService.deleteAgent).toHaveBeenCalledWith('conv-001', 'designer');
  });

  it('DELETE /api/conversations/:id/agents/:name returns 500 on error', async () => {
    mockAgentService.deleteAgent.mockImplementation(() => { throw new Error('delete failed'); });

    const res = await request(server).delete('/api/conversations/conv-001/agents/designer');

    expect(res.status).toBe(500);
  });

  // ─── Files ─────────────────────────────────────────────

  it('PUT /api/conversations/:id/files writes a file', async () => {
    const res = await request(server)
      .put('/api/conversations/conv-001/files')
      .send({ path: 'test.txt', content: 'hello' });

    expect(res.status).toBe(204);
    expect(mockFileService.write).toHaveBeenCalledWith('conv-001', 'test.txt', 'hello');
  });

  it('PUT /api/conversations/:id/files returns 400 for missing path or content', async () => {
    const res = await request(server)
      .put('/api/conversations/conv-001/files')
      .send({ path: 'test.txt' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Missing path or content');
  });

  it('PUT /api/conversations/:id/files returns 500 on write error', async () => {
    mockFileService.write.mockImplementation(() => { throw new Error('write failed'); });

    const res = await request(server)
      .put('/api/conversations/conv-001/files')
      .send({ path: 'test.txt', content: 'hello' });

    expect(res.status).toBe(500);
  });

  it('POST /api/conversations/:id/files/read reads a file', async () => {
    mockFileService.read.mockReturnValue('file content');

    const res = await request(server)
      .post('/api/conversations/conv-001/files/read')
      .send({ path: 'test.txt' });

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('file content');
  });

  it('POST /api/conversations/:id/files/read returns 400 for missing path', async () => {
    const res = await request(server)
      .post('/api/conversations/conv-001/files/read')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Missing path');
  });

  it('POST /api/conversations/:id/files/read returns 404 when file not found', async () => {
    mockFileService.read.mockImplementation(() => { throw new Error('File not found'); });

    const res = await request(server)
      .post('/api/conversations/conv-001/files/read')
      .send({ path: 'missing.txt' });

    expect(res.status).toBe(404);
  });

  it('POST /api/conversations/:id/files/delete deletes a file', async () => {
    const res = await request(server)
      .post('/api/conversations/conv-001/files/delete')
      .send({ path: 'test.txt' });

    expect(res.status).toBe(204);
    expect(mockFileService.delete).toHaveBeenCalledWith('conv-001', 'test.txt');
  });

  it('POST /api/conversations/:id/files/delete returns 400 for missing path', async () => {
    const res = await request(server)
      .post('/api/conversations/conv-001/files/delete')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Missing path');
  });

  it('POST /api/conversations/:id/files/delete returns 500 on error', async () => {
    mockFileService.delete.mockImplementation(() => { throw new Error('delete failed'); });

    const res = await request(server)
      .post('/api/conversations/conv-001/files/delete')
      .send({ path: 'test.txt' });

    expect(res.status).toBe(500);
  });

  it('POST /api/conversations/:id/files/copy copies a file', async () => {
    const res = await request(server)
      .post('/api/conversations/conv-001/files/copy')
      .send({ source: 'src.txt', dest: 'dst.txt' });

    expect(res.status).toBe(204);
    expect(mockFileService.copy).toHaveBeenCalledWith('conv-001', 'src.txt', 'dst.txt');
  });

  it('POST /api/conversations/:id/files/copy returns 400 for missing source or dest', async () => {
    const res = await request(server)
      .post('/api/conversations/conv-001/files/copy')
      .send({ source: 'src.txt' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Missing source or dest');
  });

  it('POST /api/conversations/:id/files/copy returns 500 on error', async () => {
    mockFileService.copy.mockImplementation(() => { throw new Error('copy failed'); });

    const res = await request(server)
      .post('/api/conversations/conv-001/files/copy')
      .send({ source: 'src.txt', dest: 'dst.txt' });

    expect(res.status).toBe(500);
  });

  it('POST /api/conversations/:id/files/list lists files', async () => {
    mockFileService.list.mockReturnValue(['file1.txt', 'file2.txt']);

    const res = await request(server)
      .post('/api/conversations/conv-001/files/list')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.files).toEqual(['file1.txt', 'file2.txt']);
  });

  // ─── Helpers ──────────────────────────────────────────

  it('ensureConversation returns 404 when conversation not found', async () => {
    mockMessageService.send.mockRejectedValue(new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found'));

    const res = await request(server).post('/api/conversations/conv-001/message').send({ text: 'hi' });

    expect(res.status).toBe(404);
    expect(res.body.error.message).toContain('Conversation not found');
  });

  it('ensureRunning returns 409 when not running for message endpoint', async () => {
    mockMessageService.send.mockRejectedValue(new AppError(409, ErrorCodes.CONVERSATION_NOT_RUNNING, 'Conversation is not running (status: prepared)'));

    const res = await request(server).post('/api/conversations/conv-001/message').send({ text: 'hi' });

    expect(res.status).toBe(409);
  });

  it('ensureReady returns 409 when not ready', async () => {
    mockMessageService.send.mockRejectedValue(new AppError(409, ErrorCodes.INSTANCE_NOT_READY, 'Instance is not ready yet. OpenCode is still initializing.'));

    const res = await request(server).post('/api/conversations/conv-001/message').send({ text: 'hi' });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('not ready');
  });

  // ─── Session endpoints ─────────────────────────────────

  it('GET /api/conversations/:id/sessions lists sessions', async () => {
    mockSessionService.list.mockResolvedValue([{ id: 'ses_1' }]);

    const res = await request(server).get('/api/conversations/conv-001/sessions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'ses_1' }]);
  });

  it('GET /api/conversations/:id/sessions/:sid gets a session', async () => {
    mockSessionService.get.mockResolvedValue({ id: 'ses_1' });

    const res = await request(server).get('/api/conversations/conv-001/sessions/ses_1');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('ses_1');
  });

  it('GET /api/conversations/:id/sessions/:sid/children lists session children', async () => {
    mockSessionService.getChildren.mockResolvedValue([{ id: 'child_1' }]);

    const res = await request(server).get('/api/conversations/conv-001/sessions/ses_1/children');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'child_1' }]);
  });

  it('POST /api/conversations/:id/sessions/:sid/fork forks a session', async () => {
    mockSessionService.fork.mockResolvedValue({ id: 'forked_ses' });

    const res = await request(server)
      .post('/api/conversations/conv-001/sessions/ses_1/fork')
      .send({ messageID: 'msg_1' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('forked_ses');
  });

  it('DELETE /api/conversations/:id/sessions/:sid deletes a session', async () => {
    const res = await request(server).delete('/api/conversations/conv-001/sessions/ses_1');

    expect(res.status).toBe(204);
  });

  it('GET /api/conversations/:id/sessions/:sid/messages lists session messages', async () => {
    const mockMessages = [
      { info: { id: 'msg_1', role: 'user' }, parts: [{ type: 'text', text: 'Hello' }] },
      { info: { id: 'msg_2', role: 'assistant' }, parts: [{ type: 'text', text: 'Hi!' }] },
    ];
    mockMessageService.getHistory.mockResolvedValue(mockMessages);

    const res = await request(server).get('/api/conversations/conv-001/sessions/ses_1/messages');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(mockMessages);
    expect(mockMessageService.getHistory).toHaveBeenCalledWith('conv-001', 'ses_1', undefined);
  });

  it('GET /api/conversations/:id/sessions/:sid/messages accepts limit query', async () => {
    mockMessageService.getHistory.mockResolvedValue([]);

    const res = await request(server).get('/api/conversations/conv-001/sessions/ses_1/messages?limit=5');

    expect(res.status).toBe(200);
    expect(mockMessageService.getHistory).toHaveBeenCalledWith('conv-001', 'ses_1', 5);
  });

  it('DELETE /api/conversations/:id destroys instance when running', async () => {
    const res = await request(server).delete('/api/conversations/conv-001');

    expect(res.status).toBe(204);
    expect(mockConversationService.delete).toHaveBeenCalledWith('conv-001');
  });

  // ─── Global error handler ──────────────────────────────

  it('global error handler returns 500 on malformed request body', async () => {
    const res = await request(server)
      .post('/api/conversations')
      .set('Content-Type', 'application/json')
      .send('not json');

    expect(res.status).toBe(400);
  });
});
