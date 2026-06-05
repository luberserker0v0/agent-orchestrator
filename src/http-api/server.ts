import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { ServerConfig, WebSocketConfig } from '../config-loader.js';
import type { OrchestratorConfig } from '../config-loader.js';
import { InstanceManager } from '../orchestrator/instance-manager.js';
import { WorkspaceFactory } from '../orchestrator/workspace-factory.js';
import { ConversationState } from '../orchestrator/conversation-state.js';
import { listModels } from '../opencode-cli/models.js';
import { WSRouter } from '../websocket/router.js';
import { logger } from '../utils/logger.js';
import { metricsRegistry, httpRequestsTotal } from '../metrics/registry.js';

export interface HttpServer {
  server: Server;
  closeWebSockets: () => void;
  waitForRequests: (timeoutMs: number) => Promise<void>;
}

export function createHttpServer(
  serverConfig: ServerConfig,
  wsConfig: WebSocketConfig,
  instanceManager: InstanceManager,
  workspaceFactory: WorkspaceFactory,
  conversationState: ConversationState,
  orchestratorConfig: OrchestratorConfig
): HttpServer {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.text({ limit: '5mb' }));

  let activeRequests = 0;

  // Track active requests and count finished requests
  app.use((req, res, next) => {
    activeRequests++;
    res.on('finish', () => {
      activeRequests--;
      httpRequestsTotal.inc({ method: req.method, status: String(res.statusCode) });
    });
    next();
  });

  // CORS
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // ─── Helpers ─────────────────────────────────────────────

  function getConversationId(req: Request): string {
    return req.params.id;
  }

  function ensureConversation(res: Response, id: string): boolean {
    if (!conversationState.has(id)) {
      res.status(404).json({ error: 'Conversation not found' });
      return false;
    }
    return true;
  }

  function markNeedsRestartIfRunning(id: string, reason: string): void {
    const state = conversationState.get(id);
    if (state && state.status === 'running') {
      conversationState.markNeedsRestart(id, reason);
    }
  }

  // ─── Health & Metrics ────────────────────────────────────

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
  });

  app.get('/metrics', async (_req: Request, res: Response) => {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  });

  // ─── Conversation Lifecycle ──────────────────────────────

  // Create conversation (prepare workspace, do NOT start OpenCode)
  app.post('/api/conversations', async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const id = req.body.id ?? generateId();
      if (conversationState.has(id)) {
        res.status(409).json({ error: `Conversation already exists: ${id}` });
        return;
      }

      const model = typeof req.body.model === 'string' ? req.body.model : undefined;
      const agent = typeof req.body.agent === 'string' ? req.body.agent : undefined;
      workspaceFactory.create(id, { model, agent });

      const wsUrl = `ws://${serverConfig.host}:${serverConfig.port}/ws/${id}`;
      const state = conversationState.create(id, wsUrl);

      res.status(201).json({
        id: state.id,
        status: state.status,
        wsUrl: state.wsUrl,
      });
    } catch (err) {
      logger.error('Failed to create conversation:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Start OpenCode instance
  app.post('/api/conversations/:id/start', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const state = conversationState.get(id)!;
    if (state.status === 'running' || state.status === 'starting') {
      res.status(409).json({ error: 'Conversation is already starting or running' });
      return;
    }

    conversationState.transition(id, 'starting');

    try {
      const instance = await instanceManager.createInstance(id);
      conversationState.setInstanceInfo(id, {
        port: instance.port,
        sessionId: instance.sessionId,
      });
      conversationState.setRunningInstance(id, {
        process: instance.process,
        client: instance.client,
      });
      conversationState.transition(id, 'running', {
        port: instance.port,
        sessionId: instance.sessionId,
      });
      res.json({
        id,
        status: 'running',
        port: instance.port,
        sessionId: instance.sessionId,
        wsUrl: state.wsUrl,
      });
    } catch (err) {
      conversationState.transition(id, 'error', { error: (err as Error).message });
      logger.error(`Failed to start conversation ${id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Stop OpenCode instance
  app.post('/api/conversations/:id/stop', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const state = conversationState.get(id)!;
    if (state.status !== 'running' && state.status !== 'starting' && state.status !== 'error') {
      res.status(409).json({ error: `Cannot stop conversation in status: ${state.status}` });
      return;
    }

    try {
      await instanceManager.destroyInstance(id);
      conversationState.removeRunningInstance(id);
      conversationState.transition(id, 'stopped');
      res.json({ id, status: 'stopped' });
    } catch (err) {
      logger.error(`Failed to stop conversation ${id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Restart OpenCode instance
  app.post('/api/conversations/:id/restart', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const state = conversationState.get(id)!;
    if (state.status !== 'running' && state.status !== 'stopped' && state.status !== 'error') {
      res.status(409).json({ error: `Cannot restart conversation in status: ${state.status}` });
      return;
    }

    conversationState.transition(id, 'restarting');

    try {
      // Stop existing instance if running
      if (state.status === 'running' || state.status === 'error') {
        try {
          await instanceManager.destroyInstance(id);
        } catch {
          // ignore errors stopping old instance
        }
        conversationState.removeRunningInstance(id);
      }

      conversationState.clearNeedsRestart(id);
      const instance = await instanceManager.createInstance(id);
      conversationState.setInstanceInfo(id, {
        port: instance.port,
        sessionId: instance.sessionId,
      });
      conversationState.setRunningInstance(id, {
        process: instance.process,
        client: instance.client,
      });
      conversationState.transition(id, 'running', {
        port: instance.port,
        sessionId: instance.sessionId,
      });
      res.json({
        id,
        status: 'running',
        port: instance.port,
        sessionId: instance.sessionId,
        wsUrl: state.wsUrl,
      });
    } catch (err) {
      conversationState.transition(id, 'error', { error: (err as Error).message });
      logger.error(`Failed to restart conversation ${id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Delete conversation (destroy instance + remove workspace)
  app.delete('/api/conversations/:id', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const state = conversationState.get(id)!;
      if (state.status === 'running' || state.status === 'starting') {
        await instanceManager.destroyInstance(id);
      }
      workspaceFactory.destroy(id);
      conversationState.transition(id, 'destroyed');
      conversationState.remove(id);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to delete conversation ${id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // List conversations
  app.get('/api/conversations', (_req: Request, res: Response) => {
    const conversations = conversationState.list().map((s) => ({
      id: s.id,
      status: s.status,
      needsRestart: s.needsRestart,
      port: s.port,
      sessionId: s.sessionId,
      wsUrl: s.wsUrl,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
    res.json(conversations);
  });

  // Get conversation events
  app.get('/api/conversations/:id/events', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const events = conversationState.getRecentEvents(id, limit);
    res.json(events);
  });

  // ─── Config ──────────────────────────────────────────────

  app.patch('/api/conversations/:id/config', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const config = req.body.config;
      if (typeof config !== 'object' || config === null) {
        res.status(400).json({ error: 'Missing or invalid config body' });
        return;
      }
      workspaceFactory.writeConfig(id, config);
      markNeedsRestartIfRunning(id, 'opencode.json changed');
      conversationState.emitEvent(id, 'conversation.configChanged', { changedFiles: ['.opencode/opencode.json'] });
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to update config for ${id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/conversations/:id/config', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const config = workspaceFactory.readConfig(id);
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Agents ────────────────────────────────────────────

  app.put('/api/conversations/:id/agents', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const name = typeof req.body.name === 'string' ? req.body.name : undefined;
    const content = typeof req.body.content === 'string' ? req.body.content : undefined;

    if (!name || content === undefined) {
      res.status(400).json({ error: 'Missing name or content' });
      return;
    }

    try {
      workspaceFactory.writeAgent(id, name, content);
      markNeedsRestartIfRunning(id, `agent ${name} updated`);
      conversationState.emitEvent(id, 'conversation.configChanged', {
        changedFiles: [`.opencode/agents/${name}.md`],
      });
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to register agent ${name} for ${id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/conversations/:id/agents', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const agents = workspaceFactory.listAgents(id);
      res.json(agents);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/conversations/:id/agents/:name', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const content = workspaceFactory.readAgent(id, req.params.name);
      res.json({ name: req.params.name, content });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/conversations/:id/agents/:name', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      workspaceFactory.deleteAgent(id, req.params.name);
      markNeedsRestartIfRunning(id, `agent ${req.params.name} deleted`);
      conversationState.emitEvent(id, 'conversation.configChanged', {
        changedFiles: [`.opencode/agents/${req.params.name}.md`],
      });
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Files ───────────────────────────────────────────────

  app.put('/api/conversations/:id/files', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const path = typeof req.body.path === 'string' ? req.body.path : undefined;
    const content = typeof req.body.content === 'string' ? req.body.content : undefined;

    if (path === undefined || content === undefined) {
      res.status(400).json({ error: 'Missing path or content' });
      return;
    }

    try {
      workspaceFactory.writeFile(id, path, content);
      markNeedsRestartIfRunning(id, `file ${path} updated`);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to write file ${path} for ${id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/conversations/:id/files', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const path = typeof req.body.path === 'string' ? req.body.path : undefined;
    if (path === undefined) {
      res.status(400).json({ error: 'Missing path in body' });
      return;
    }

    try {
      const content = workspaceFactory.readFile(id, path);
      res.json({ path, content });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/conversations/:id/files', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const path = typeof req.body.path === 'string' ? req.body.path : undefined;
    if (path === undefined) {
      res.status(400).json({ error: 'Missing path in body' });
      return;
    }

    try {
      workspaceFactory.deleteFile(id, path);
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/conversations/:id/files/copy', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const source = typeof req.body.source === 'string' ? req.body.source : undefined;
    const dest = typeof req.body.dest === 'string' ? req.body.dest : undefined;

    if (!source || !dest) {
      res.status(400).json({ error: 'Missing source or dest' });
      return;
    }

    try {
      workspaceFactory.copyFromLocal(id, source, dest);
      markNeedsRestartIfRunning(id, `file copied to ${dest}`);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to copy file for ${id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/conversations/:id/files/list', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const path = typeof req.body.path === 'string' ? req.body.path : '';

    try {
      const files = workspaceFactory.listFiles(id, path || undefined);
      res.json({ path: path || '.', files });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Sessions (proxy to OpenCode, only when running) ─────

  function ensureRunning(res: Response, id: string): boolean {
    if (!ensureConversation(res, id)) return false;
    const state = conversationState.get(id)!;
    if (state.status !== 'running') {
      res.status(409).json({ error: `Conversation is not running (status: ${state.status})` });
      return false;
    }
    return true;
  }

  app.post('/api/conversations/:id/sessions', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureRunning(res, id)) return;

    try {
      const instance = instanceManager.getInstance(id);
      if (!instance) {
        res.status(500).json({ error: 'Instance reference lost' });
        return;
      }
      const session = await instance.client.createSession({
        title: req.body.title,
        parentID: req.body.parentID,
      });
      res.status(201).json(session);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/conversations/:id/sessions', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureRunning(res, id)) return;

    try {
      const instance = instanceManager.getInstance(id);
      if (!instance) {
        res.status(500).json({ error: 'Instance reference lost' });
        return;
      }
      const sessions = await instance.client.listSessions();
      res.json(sessions);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/conversations/:id/sessions/:sid', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureRunning(res, id)) return;

    try {
      const instance = instanceManager.getInstance(id);
      if (!instance) {
        res.status(500).json({ error: 'Instance reference lost' });
        return;
      }
      const session = await instance.client.getSession(req.params.sid);
      res.json(session);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/conversations/:id/sessions/:sid/children', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureRunning(res, id)) return;

    try {
      const instance = instanceManager.getInstance(id);
      if (!instance) {
        res.status(500).json({ error: 'Instance reference lost' });
        return;
      }
      const children = await instance.client.getSessionChildren(req.params.sid);
      res.json(children);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/conversations/:id/sessions/:sid/fork', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureRunning(res, id)) return;

    try {
      const instance = instanceManager.getInstance(id);
      if (!instance) {
        res.status(500).json({ error: 'Instance reference lost' });
        return;
      }
      const session = await instance.client.forkSession(req.params.sid, req.body.messageID);
      res.status(201).json(session);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/conversations/:id/sessions/:sid', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureRunning(res, id)) return;

    try {
      const instance = instanceManager.getInstance(id);
      if (!instance) {
        res.status(500).json({ error: 'Instance reference lost' });
        return;
      }
      await instance.client.deleteSession(req.params.sid);
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Models ────────────────────────────────────────────

  app.get('/api/models', async (_req: Request, res: Response) => {
    try {
      const models = await listModels(orchestratorConfig.opencodeBinary);
      res.json(models);
    } catch (err) {
      logger.error('Failed to list models:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Global error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('HTTP error:', err);
    res.status(500).json({ error: err.message });
  });

  // ─── HTTP & WebSocket Server ───────────────────────────

  const httpServer = createServer(app);

  const wss = new WebSocketServer({ noServer: true });
  const wsRouter = new WSRouter(wss, instanceManager, workspaceFactory, conversationState, wsConfig, serverConfig);

  httpServer.on('upgrade', (request, socket, head) => {
    const pathname = request.url ?? '';
    if (pathname.startsWith('/ws/')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  const closeWebSockets = (): void => {
    wsRouter.closeAll();
  };

  const waitForRequests = (timeoutMs: number): Promise<void> => {
    return new Promise((resolve) => {
      if (activeRequests === 0) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        logger.warn(`Graceful shutdown: ${activeRequests} request(s) still in-flight after ${timeoutMs}ms`);
        resolve();
      }, timeoutMs);
      const checkInterval = setInterval(() => {
        if (activeRequests === 0) {
          clearTimeout(timer);
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  };

  return { server: httpServer, closeWebSockets, waitForRequests };
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
