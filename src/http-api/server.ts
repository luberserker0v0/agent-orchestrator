import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import swaggerUi from 'swagger-ui-express';
import type { ServerConfig, WebSocketConfig } from '../config-loader.js';
import type { OrchestratorConfig } from '../config-loader.js';
import { InstanceManager, type InstanceInfo } from '../orchestrator/instance-manager.js';
import type { AgentClient } from '../agent-runtime/types.js';
import { RuntimeRegistry } from '../agent-runtime/registry.js';
import { WorkspaceFactory, validateSkillName } from '../orchestrator/workspace-factory.js';
import { ConversationState } from '../orchestrator/conversation-state.js';
import { ConfigService } from '../services/config-service.js';
import { AgentService } from '../services/agent-service.js';
import { SkillService } from '../services/skill-service.js';
import { WSRouter } from '../websocket/router.js';
import { logger } from '../utils/logger.js';
import { metricsRegistry, httpRequestsTotal } from '../metrics/registry.js';
import { openapiSpec } from './openapi.js';

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
  orchestratorConfig: OrchestratorConfig,
  configService: ConfigService,
  agentService: AgentService,
  skillService: SkillService,
  runtimeRegistry: RuntimeRegistry
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

  function createSessionInBackground(id: string, client: AgentClient): void {
    client.createSession({ title: `AgentOrchestrator-${id}` })
      .then((session) => {
        conversationState.setInstanceInfo(id, { sessionId: session.id });
        instanceManager.setSessionId(id, session.id);
        logger.info(`[OpenCode ${id}] session created: ${session.id}`);
      })
      .catch((err) => {
        logger.error(`[OpenCode ${id}] failed to create session: ${(err as Error).message}`);
        // Instance stays running — user can reconfigure provider and restart
      });
  }

  // ─── Swagger UI ─────────────────────────────────────────

  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
    customSiteTitle: 'AgentOrchestrator API Docs',
  }));

  app.get('/api-docs.json', (_req: Request, res: Response) => {
    res.json(openapiSpec);
  });

  // ─── Health & Metrics ────────────────────────────────────

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
  });

  app.get('/metrics', async (_req: Request, res: Response) => {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  });

  // ─── Conversation Lifecycle ──────────────────────────────

  // Create conversation (prepare workspace, do NOT start agent instance)
  app.post('/api/conversations', async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const id = req.body.id ?? generateId();
      if (conversationState.has(id)) {
        res.status(409).json({ error: `Conversation already exists: ${id}` });
        return;
      }

      const agentType = typeof req.body.agentType === 'string' ? req.body.agentType : orchestratorConfig.agentType;
      if (!runtimeRegistry.get(agentType)) {
        res.status(400).json({ error: `Unknown agent type: ${agentType}. Available: ${runtimeRegistry.list().join(', ')}` });
        return;
      }

      workspaceFactory.create(id);

      const wsUrl = `ws://${serverConfig.host}:${serverConfig.port}/ws/${id}`;
      const state = conversationState.create(id, agentType, wsUrl);

      res.status(201).json({
        id: state.id,
        agentType: state.agentType,
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

    conversationState.cancelReadyCheck(id);
    conversationState.transition(id, 'starting');

    try {
      const instance = await instanceManager.createInstance(id, state.agentType);
      conversationState.setInstanceInfo(id, { port: instance.port });
      conversationState.setRunningInstance(id, {
        process: instance.process!,
        client: instance.client,
      });
      conversationState.transition(id, 'running');
      conversationState.startReadyCheck(id);
      res.json({
        id,
        agentType: state.agentType,
        status: 'running',
        ready: false,
        port: instance.port,
        wsUrl: state.wsUrl,
        sessionId: state.sessionId,
      });

      createSessionInBackground(id, instance.client);
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
    const previousStatus = state.status;
    if (previousStatus !== 'running' && previousStatus !== 'stopped' && previousStatus !== 'error') {
      res.status(409).json({ error: `Cannot restart conversation in status: ${previousStatus}` });
      return;
    }

    conversationState.transition(id, 'restarting');

    try {
      const hadInstance = previousStatus === 'running' || previousStatus === 'error';
      let dockerRestarted = false;

      if (hadInstance) {
        conversationState.cancelReadyCheck(id);
        if (orchestratorConfig.runtime === 'docker') {
          // Docker: try to restart the existing container in-place
          try {
            await instanceManager.restartInstance(id);
            dockerRestarted = true;
          } catch {
            // Restart failed — fall back to kill + respawn
            await instanceManager.stopInstance(id).catch(() => {});
            conversationState.removeRunningInstance(id);
          }
        } else {
          // Direct: kill old process
          await instanceManager.stopInstance(id);
          conversationState.removeRunningInstance(id);
        }
      }

      conversationState.clearNeedsRestart(id);

      let instance: InstanceInfo;
      if (dockerRestarted) {
        // Docker restart succeeded — reuse existing instance (same port, same container)
        instance = instanceManager.getInstance(id)!;
      } else {
        instance = await instanceManager.createInstance(id, state.agentType);
        conversationState.setInstanceInfo(id, { port: instance.port });
        conversationState.setRunningInstance(id, {
          process: instance.process!,
          client: instance.client,
        });
      }

      conversationState.transition(id, 'running');
      conversationState.startReadyCheck(id);
      res.json({
        id,
        agentType: state.agentType,
        status: 'running',
        ready: false,
        port: instance.port,
        wsUrl: state.wsUrl,
        sessionId: state.sessionId,
      });

      createSessionInBackground(id, instance.client);
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
      // Always try to destroy the instance (no-op if none running)
      try {
        await instanceManager.destroyInstance(id);
      } catch {
        // ignore if no instance or already cleaned up
      }
      // Always try to remove the workspace (no-op if already gone)
      try {
        workspaceFactory.destroy(id);
      } catch (wsErr) {
        logger.warn(`Failed to remove workspace for ${id}:`, wsErr);
      }
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
      agentType: s.agentType,
      status: s.status,
      ready: s.ready,
      needsRestart: s.needsRestart,
      port: s.port,
      sessionId: s.sessionId,
      wsUrl: s.wsUrl,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
    res.json(conversations);
  });

  // Get single conversation
  app.get('/api/conversations/:id', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;
    const s = conversationState.get(id)!;
    res.json({
      id: s.id,
      agentType: s.agentType,
      status: s.status,
      ready: s.ready,
      needsRestart: s.needsRestart,
      port: s.port,
      sessionId: s.sessionId,
      wsUrl: s.wsUrl,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
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

  app.get('/api/conversations/:id/config', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const config = configService.readConfig(id);
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/conversations/:id/config', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const config = req.body;
      if (typeof config !== 'object' || config === null) {
        res.status(400).json({ error: 'Request body must be a JSON object' });
        return;
      }
      configService.writeConfig(id, config);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to write config for ${id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.patch('/api/conversations/:id/config', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const patch = req.body;
      if (typeof patch !== 'object' || patch === null) {
        res.status(400).json({ error: 'Request body must be a JSON object' });
        return;
      }

      configService.patchConfig(id, patch);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to patch config for ${id}:`, err);
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
      agentService.writeAgent(id, name, content);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to register agent ${name} for ${id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/conversations/:id/agents', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const result = await agentService.listAgentsWithRuntime(id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/conversations/:id/agents/:name', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const content = agentService.readAgent(id, req.params.name);
      res.json({ name: req.params.name, content });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/conversations/:id/agents/:name', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      agentService.deleteAgent(id, req.params.name);
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── AGENTS.md ─────────────────────────────────────────

  app.put('/api/conversations/:id/agent/config', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const content = typeof req.body.content === 'string' ? req.body.content : undefined;
    if (content === undefined) {
      res.status(400).json({ error: 'Missing content' });
      return;
    }

    try {
      agentService.writeAgentsMd(id, content);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to write AGENTS.md for ${id}:`, err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/conversations/:id/agent/config', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const content = agentService.readAgentsMd(id);
      res.json({ content });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/conversations/:id/agent/config', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      agentService.deleteAgentsMd(id);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to delete AGENTS.md for ${id}:`, err);
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
      const msg = (err as Error).message;
      if (msg.includes('path traversal') || msg.includes('Invalid path')) {
        res.status(400).json({ error: msg });
      } else {
        logger.error(`Failed to write file ${path} for ${id}:`, err);
        res.status(500).json({ error: msg });
      }
    }
  });

  app.post('/api/conversations/:id/files/read', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const path = typeof req.body.path === 'string' ? req.body.path : undefined;
    if (!path) {
      res.status(400).json({ error: 'Missing path' });
      return;
    }

    try {
      const content = workspaceFactory.readFile(id, path);
      res.json({ path, content });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  app.post('/api/conversations/:id/files/delete', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const path = typeof req.body.path === 'string' ? req.body.path : undefined;
    if (!path) {
      res.status(400).json({ error: 'Missing path' });
      return;
    }

    try {
      workspaceFactory.deleteFile(id, path);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to delete file ${path} for ${id}:`, err);
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

  app.post('/api/conversations/:id/files/list', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const path = typeof req.body.path === 'string' ? req.body.path : undefined;

    try {
      const files = workspaceFactory.listFiles(id, path);
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

  function ensureReady(res: Response, id: string): boolean {
    if (!ensureRunning(res, id)) return false;
    const state = conversationState.get(id)!;
    if (!state.ready) {
      res.status(409).json({ error: 'Instance is not ready yet. OpenCode is still initializing.' });
      return false;
    }
    return true;
  }

  app.post('/api/conversations/:id/sessions', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureReady(res, id)) return;

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
    if (!ensureReady(res, id)) return;

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
    if (!ensureReady(res, id)) return;

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
    if (!ensureReady(res, id)) return;

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
    if (!ensureReady(res, id)) return;

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
    if (!ensureReady(res, id)) return;

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

  app.get('/api/conversations/:id/sessions/:sid/messages', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureReady(res, id)) return;

    try {
      const instance = instanceManager.getInstance(id);
      if (!instance) {
        res.status(500).json({ error: 'Instance reference lost' });
        return;
      }
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const messages = await instance.client.listMessages(req.params.sid, limit);
      res.json(messages);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Providers (proxy to running instance) ─────────────

  app.get('/api/conversations/:id/providers', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureReady(res, id)) return;

    try {
      const instance = instanceManager.getInstance(id);
      if (!instance) {
        res.status(500).json({ error: 'Instance reference lost' });
        return;
      }
      const providers = await instance.client.listProviders();
      res.json(providers);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Message ───────────────────────────────────────────

  app.post('/api/conversations/:id/message', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureReady(res, id)) return;

    const { text, model: rawModel, agent: rawAgent } = req.body as { text?: string; model?: string; agent?: string };
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Missing or invalid text field' });
      return;
    }

    try {
      const instance = instanceManager.getInstance(id);
      if (!instance) {
        res.status(500).json({ error: 'Instance reference lost' });
        return;
      }

      let model: { providerID: string; modelID: string } | undefined;
      if (rawModel && typeof rawModel === 'string') {
        const parts = rawModel.split('/');
        if (parts.length >= 2) {
          model = { providerID: parts[0], modelID: parts.slice(1).join('/') };
        }
      }

      const agent = typeof rawAgent === 'string' ? rawAgent : undefined;

      if (!instance.sessionId) {
        res.status(503).json({ error: 'Session not ready yet' });
        return;
      }

      const response = await instance.client.sendPrompt(instance.sessionId, {
        model,
        agent,
        parts: [{ type: 'text', text: text }],
      });

      const texts = response.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as unknown as { text: string }).text)
        .join('');

      conversationState.emitEvent(id, 'conversation.message', {
        messageId: response.info.id,
        text: texts,
        parts: response.parts,
        role: 'assistant',
      });
      res.json({ messageId: response.info.id, text: texts, parts: response.parts });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Skills ────────────────────────────────────────────

  // Upload skill as zip archive
  app.post('/api/conversations/:id/skills/upload', express.raw({ type: 'application/zip', limit: '10mb' }), (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const rawName = typeof req.query.name === 'string' ? req.query.name : undefined;
    if (!rawName) {
      res.status(400).json({ error: 'Missing name query parameter' });
      return;
    }

    try {
      validateSkillName(rawName);
    } catch {
      res.status(400).json({ error: 'Invalid skill name' });
      return;
    }

    try {
      skillService.uploadSkill(id, rawName, req.body as Buffer);
      res.status(204).send();
    } catch (err) {
      const message = (err as Error).message;
      logger.error(`Failed to upload skill for ${id}:`, err);
      if (message.includes('Skill archive must contain SKILL.md')) {
        res.status(400).json({ error: message });
      } else if (message.includes('Invalid zip entry path')) {
        res.status(400).json({ error: message });
      } else if (message.includes('Workspace quota exceeded')) {
        res.status(413).json({ error: 'Skill archive exceeds workspace quota' });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  // Import skill from local directory
  app.post('/api/conversations/:id/skills/import', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const source = typeof req.body.source === 'string' ? req.body.source : undefined;
    const name = typeof req.body.name === 'string' ? req.body.name : undefined;

    if (!source || !name) {
      res.status(400).json({ error: 'Missing source or name' });
      return;
    }

    try {
      validateSkillName(name);
    } catch {
      res.status(400).json({ error: 'Invalid skill name' });
      return;
    }

    try {
      skillService.importSkill(id, source, name);
      res.status(204).send();
    } catch (err) {
      const message = (err as Error).message;
      logger.error(`Failed to import skill for ${id}:`, err);
      if (message.includes('Source path not allowed')) {
        res.status(403).json({ error: message });
      } else if (message.includes('Source not found') || message.includes('Source must be a directory')) {
        res.status(404).json({ error: message });
      } else if (message.includes('Workspace quota exceeded')) {
        res.status(413).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  // List skills
  app.get('/api/conversations/:id/skills', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const skills = skillService.listSkills(id);
      res.json(skills);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Read skill content (SKILL.md)
  app.get('/api/conversations/:id/skills/:name', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      validateSkillName(req.params.name);
    } catch {
      res.status(400).json({ error: 'Invalid skill name' });
      return;
    }

    try {
      const content = skillService.readSkill(id, req.params.name);
      res.json({ name: req.params.name, content });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // Get skill info (files, size, hash)
  app.get('/api/conversations/:id/skills/:name/info', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      validateSkillName(req.params.name);
    } catch {
      res.status(400).json({ error: 'Invalid skill name' });
      return;
    }

    try {
      const info = skillService.getSkillInfo(id, req.params.name);
      res.json(info);
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  // Delete skill
  app.delete('/api/conversations/:id/skills/:name', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      validateSkillName(req.params.name);
    } catch {
      res.status(400).json({ error: 'Invalid skill name' });
      return;
    }

    try {
      skillService.deleteSkill(id, req.params.name);
      res.status(204).send();
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('Skill not found')) {
        res.status(404).json({ error: message });
      } else {
        res.status(500).json({ error: message });
      }
    }
  });

  // Global error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('HTTP error:', err);
    const status = (err as any).status ?? (err as any).statusCode ?? 500;
    res.status(status).json({ error: err.message });
  });

  // ─── HTTP & WebSocket Server ───────────────────────────

  const httpServer = createServer(app);

  const wss = new WebSocketServer({ noServer: true });
  const wsRouter = new WSRouter(wss, instanceManager, workspaceFactory, conversationState, wsConfig, serverConfig, orchestratorConfig, configService, agentService, skillService, runtimeRegistry);

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
