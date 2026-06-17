import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import swaggerUi from 'swagger-ui-express';
import type { ServerConfig, WebSocketConfig } from '../config-loader.js';
import type { OrchestratorConfig } from '../config-loader.js';
import { InstanceManager } from '../orchestrator/instance-manager.js';
import { RuntimeRegistry } from '../agent-runtime/registry.js';
import { WorkspaceFactory, validateSkillName } from '../orchestrator/workspace-factory.js';
import { ConversationState } from '../orchestrator/conversation-state.js';
import { ConfigService } from '../services/config-service.js';
import { AgentService } from '../services/agent-service.js';
import { SkillService } from '../services/skill-service.js';
import { ConversationService } from '../services/conversation-service.js';
import { FileService } from '../services/file-service.js';
import { SessionService } from '../services/session-service.js';
import { MessageService } from '../services/message-service.js';
import { WSRouter } from '../websocket/router.js';
import { logger } from '../utils/logger.js';
import { metricsRegistry, httpRequestsTotal, httpRequestDurationSeconds } from '../metrics/registry.js';
import { openapiSpec } from './openapi.js';
import { ErrorCodes, isAppError, toHttpErrorResponse } from '../utils/errors.js';

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
  runtimeRegistry: RuntimeRegistry,
  conversationService: ConversationService,
  fileService: FileService,
  sessionService: SessionService,
  messageService: MessageService
): HttpServer {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(express.text({ limit: '5mb' }));

  let activeRequests = 0;

  // Track active requests, duration, and count finished requests
  app.use((req, res, next) => {
    activeRequests++;
    const endTimer = httpRequestDurationSeconds.startTimer({ method: req.method });
    res.on('finish', () => {
      activeRequests--;
      const status = String(res.statusCode);
      endTimer({ status });
      httpRequestsTotal.inc({ method: req.method, status });
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

  function sendError(res: Response, status: number, code: string, message: string): void {
    res.status(status).json({ error: { code, message } });
  }

  function handleControllerError(res: Response, err: unknown, defaultStatus = 500): void {
    if (isAppError(err)) {
      sendError(res, err.statusCode, err.code, err.message);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, defaultStatus, ErrorCodes.INTERNAL_ERROR, message);
    }
  }

  function ensureConversation(res: Response, id: string): boolean {
    if (!conversationState.has(id)) {
      sendError(res, 404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
      return false;
    }
    return true;
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
  app.post('/api/conversations', async (req: Request, res: Response) => {
    try {
      const id = typeof req.body.id === 'string' ? req.body.id : undefined;
      const agentType = typeof req.body.agentType === 'string' ? req.body.agentType : undefined;
      const data = conversationService.create(id, agentType);
      res.status(201).json(data);
    } catch (err) {
      logger.error('Failed to create conversation:', err);
      handleControllerError(res, err);
    }
  });

  // Start OpenCode instance
  app.post('/api/conversations/:id/start', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    try {
      const result = await conversationService.start(id);
      res.json(result);
    } catch (err) {
      logger.error(`Failed to start conversation ${id}:`, err);
      handleControllerError(res, err);
    }
  });

  // Stop OpenCode instance
  app.post('/api/conversations/:id/stop', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    try {
      await conversationService.stop(id);
      res.json({ id, status: 'stopped' });
    } catch (err) {
      logger.error(`Failed to stop conversation ${id}:`, err);
      handleControllerError(res, err);
    }
  });

  // Restart OpenCode instance
  app.post('/api/conversations/:id/restart', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    try {
      const result = await conversationService.restart(id);
      res.json(result);
    } catch (err) {
      logger.error(`Failed to restart conversation ${id}:`, err);
      handleControllerError(res, err);
    }
  });

  // Delete conversation (destroy instance + remove workspace)
  app.delete('/api/conversations/:id', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    try {
      await conversationService.delete(id);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to delete conversation ${id}:`, err);
      handleControllerError(res, err);
    }
  });

  // List conversations
  app.get('/api/conversations', (_req: Request, res: Response) => {
    res.json(conversationService.list());
  });

  // Get single conversation
  app.get('/api/conversations/:id', (req: Request, res: Response) => {
    const id = getConversationId(req);
    try {
      const data = conversationService.get(id);
      res.json(data);
    } catch (err) {
      handleControllerError(res, err);
    }
  });

  // Get conversation events
  app.get('/api/conversations/:id/events', (req: Request, res: Response) => {
    const id = getConversationId(req);
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const events = conversationService.getEvents(id, limit);
      res.json(events);
    } catch (err) {
      handleControllerError(res, err);
    }
  });

  // ─── Config ──────────────────────────────────────────────

  app.get('/api/conversations/:id/config', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const config = configService.readConfig(id);
      res.json(config);
    } catch (err) {
      handleControllerError(res, err);
    }
  });

  app.post('/api/conversations/:id/config', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const config = req.body;
      if (typeof config !== 'object' || config === null) {
        sendError(res, 400, ErrorCodes.INVALID_REQUEST_BODY, 'Request body must be a JSON object');
        return;
      }
      configService.writeConfig(id, config);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to write config for ${id}:`, err);
      handleControllerError(res, err);
    }
  });

  app.patch('/api/conversations/:id/config', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const patch = req.body;
      if (typeof patch !== 'object' || patch === null) {
        sendError(res, 400, ErrorCodes.INVALID_REQUEST_BODY, 'Request body must be a JSON object');
        return;
      }

      configService.patchConfig(id, patch);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to patch config for ${id}:`, err);
      handleControllerError(res, err);
    }
  });

  // ─── Agents ────────────────────────────────────────────

  app.put('/api/conversations/:id/agents', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const name = typeof req.body.name === 'string' ? req.body.name : undefined;
    const content = typeof req.body.content === 'string' ? req.body.content : undefined;

    if (!name || content === undefined) {
      sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing name or content');
      return;
    }

    try {
      agentService.writeAgent(id, name, content);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to register agent ${name} for ${id}:`, err);
      handleControllerError(res, err);
    }
  });

  app.get('/api/conversations/:id/agents', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const result = await agentService.listAgentsWithRuntime(id);
      res.json(result);
    } catch (err) {
      handleControllerError(res, err);
    }
  });

  app.get('/api/conversations/:id/agents/:name', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const content = agentService.readAgent(id, req.params.name);
      res.json({ name: req.params.name, content });
    } catch (err) {
      handleControllerError(res, err, 404);
    }
  });

  app.delete('/api/conversations/:id/agents/:name', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      agentService.deleteAgent(id, req.params.name);
      res.status(204).send();
    } catch (err) {
      handleControllerError(res, err);
    }
  });

  // ─── AGENTS.md ─────────────────────────────────────────

  app.put('/api/conversations/:id/agent/config', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const content = typeof req.body.content === 'string' ? req.body.content : undefined;
    if (content === undefined) {
      sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing content');
      return;
    }

    try {
      agentService.writeAgentsMd(id, content);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to write AGENTS.md for ${id}:`, err);
      handleControllerError(res, err);
    }
  });

  app.get('/api/conversations/:id/agent/config', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      const content = agentService.readAgentsMd(id);
      res.json({ content });
    } catch (err) {
      handleControllerError(res, err, 404);
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
      handleControllerError(res, err);
    }
  });

  // ─── Files ───────────────────────────────────────────────

  app.put('/api/conversations/:id/files', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const path = typeof req.body.path === 'string' ? req.body.path : undefined;
    const content = typeof req.body.content === 'string' ? req.body.content : undefined;

    if (path === undefined || content === undefined) {
      sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing path or content');
      return;
    }

    try {
      fileService.write(id, path, content);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to write file ${path} for ${id}:`, err);
      handleControllerError(res, err);
    }
  });

  app.post('/api/conversations/:id/files/read', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const path = typeof req.body.path === 'string' ? req.body.path : undefined;
    if (!path) {
      sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing path');
      return;
    }

    try {
      const content = fileService.read(id, path);
      res.json({ path, content });
    } catch (err) {
      handleControllerError(res, err, 404);
    }
  });

  app.post('/api/conversations/:id/files/delete', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const path = typeof req.body.path === 'string' ? req.body.path : undefined;
    if (!path) {
      sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing path');
      return;
    }

    try {
      fileService.delete(id, path);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to delete file ${path} for ${id}:`, err);
      handleControllerError(res, err);
    }
  });

  app.post('/api/conversations/:id/files/copy', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const source = typeof req.body.source === 'string' ? req.body.source : undefined;
    const dest = typeof req.body.dest === 'string' ? req.body.dest : undefined;

    if (!source || !dest) {
      sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing source or dest');
      return;
    }

    try {
      fileService.copy(id, source, dest);
      res.status(204).send();
    } catch (err) {
      logger.error(`Failed to copy file for ${id}:`, err);
      handleControllerError(res, err);
    }
  });

  app.post('/api/conversations/:id/files/list', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const path = typeof req.body.path === 'string' ? req.body.path : undefined;

    try {
      const files = fileService.list(id, path);
      res.json({ path: path || '.', files });
    } catch (err) {
      handleControllerError(res, err);
    }
  });

  // ─── Sessions (proxy to OpenCode, only when running) ─────

  app.post('/api/conversations/:id/sessions', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    try {
      const session = await sessionService.create(id, req.body);
      res.status(201).json(session);
    } catch (err) {
      handleControllerError(res, err);
    }
  });

  app.get('/api/conversations/:id/sessions', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    try {
      const sessions = await sessionService.list(id);
      res.json(sessions);
    } catch (err) {
      handleControllerError(res, err);
    }
  });

  app.get('/api/conversations/:id/sessions/:sid', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    try {
      const session = await sessionService.get(id, req.params.sid);
      res.json(session);
    } catch (err) {
      handleControllerError(res, err);
    }
  });

  app.get('/api/conversations/:id/sessions/:sid/children', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    try {
      const children = await sessionService.getChildren(id, req.params.sid);
      res.json(children);
    } catch (err) {
      handleControllerError(res, err);
    }
  });

  app.post('/api/conversations/:id/sessions/:sid/fork', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    try {
      const session = await sessionService.fork(id, req.params.sid, req.body.messageID);
      res.status(201).json(session);
    } catch (err) {
      handleControllerError(res, err);
    }
  });

  app.delete('/api/conversations/:id/sessions/:sid', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    try {
      await sessionService.delete(id, req.params.sid);
      res.status(204).send();
    } catch (err) {
      handleControllerError(res, err);
    }
  });

  app.get('/api/conversations/:id/sessions/:sid/messages', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    try {
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const messages = await messageService.getHistory(id, req.params.sid, limit);
      res.json(messages);
    } catch (err) {
      handleControllerError(res, err);
    }
  });

  app.post('/api/conversations/:id/sessions/abort', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    try {
      const result = await sessionService.abort(id);
      res.json(result);
    } catch (err) {
      handleControllerError(res, err);
    }
  });

  // ─── Providers (proxy to running instance) ─────────────

  app.get('/api/conversations/:id/providers', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    try {
      const providers = await sessionService.listProviders(id);
      res.json(providers);
    } catch (err) {
      handleControllerError(res, err);
    }
  });

  // ─── Message ───────────────────────────────────────────

  app.post('/api/conversations/:id/message', async (req: Request, res: Response) => {
    const id = getConversationId(req);
    const { text, model: rawModel, agent: rawAgent } = req.body as { text?: string; model?: string; agent?: string };
    if (!text || typeof text !== 'string') {
      sendError(res, 400, ErrorCodes.INVALID_TEXT, 'Missing or invalid text field');
      return;
    }

    try {
      const result = await messageService.send(id, text, rawModel, rawAgent);
      res.json(result);
    } catch (err) {
      handleControllerError(res, err);
    }
  });

  // ─── Skills ────────────────────────────────────────────

  // Upload skill as zip archive
  app.post('/api/conversations/:id/skills/upload', express.raw({ type: 'application/zip', limit: '10mb' }), (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    const rawName = typeof req.query.name === 'string' ? req.query.name : undefined;
    if (!rawName) {
      sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing name query parameter');
      return;
    }

    try {
      validateSkillName(rawName);
    } catch {
      sendError(res, 400, ErrorCodes.INVALID_SKILL_NAME, 'Invalid skill name');
      return;
    }

    try {
      skillService.uploadSkill(id, rawName, req.body as Buffer);
      res.status(204).send();
    } catch (err) {
      const message = (err as Error).message;
      logger.error(`Failed to upload skill for ${id}:`, err);
      if (isAppError(err)) {
        sendError(res, err.statusCode, err.code, err.message);
      } else if (message.includes('Skill archive must contain SKILL.md')) {
        sendError(res, 400, ErrorCodes.SKILL_INVALID_ARCHIVE, message);
      } else if (message.includes('Invalid zip entry path')) {
        sendError(res, 400, ErrorCodes.SKILL_INVALID_ARCHIVE, message);
      } else if (message.includes('Workspace quota exceeded')) {
        sendError(res, 413, ErrorCodes.SKILL_QUOTA_EXCEEDED, 'Skill archive exceeds workspace quota');
      } else {
        sendError(res, 500, ErrorCodes.INTERNAL_ERROR, message);
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
      sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing source or name');
      return;
    }

    try {
      validateSkillName(name);
    } catch {
      sendError(res, 400, ErrorCodes.INVALID_SKILL_NAME, 'Invalid skill name');
      return;
    }

    try {
      skillService.importSkill(id, source, name);
      res.status(204).send();
    } catch (err) {
      const message = (err as Error).message;
      logger.error(`Failed to import skill for ${id}:`, err);
      if (isAppError(err)) {
        sendError(res, err.statusCode, err.code, err.message);
      } else if (message.includes('Source path not allowed')) {
        sendError(res, 403, ErrorCodes.SOURCE_NOT_ALLOWED, message);
      } else if (message.includes('Source not found') || message.includes('Source must be a directory')) {
        sendError(res, 404, ErrorCodes.SOURCE_NOT_FOUND, message);
      } else if (message.includes('Workspace quota exceeded')) {
        sendError(res, 413, ErrorCodes.WORKSPACE_QUOTA_EXCEEDED, message);
      } else {
        sendError(res, 500, ErrorCodes.INTERNAL_ERROR, message);
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
      handleControllerError(res, err);
    }
  });

  app.get('/api/conversations/:id/skills/:name', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      validateSkillName(req.params.name);
    } catch {
      sendError(res, 400, ErrorCodes.INVALID_SKILL_NAME, 'Invalid skill name');
      return;
    }

    try {
      const content = skillService.readSkill(id, req.params.name);
      res.json({ name: req.params.name, content });
    } catch (err) {
      handleControllerError(res, err, 404);
    }
  });

  app.get('/api/conversations/:id/skills/:name/info', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      validateSkillName(req.params.name);
    } catch {
      sendError(res, 400, ErrorCodes.INVALID_SKILL_NAME, 'Invalid skill name');
      return;
    }

    try {
      const info = skillService.getSkillInfo(id, req.params.name);
      res.json(info);
    } catch (err) {
      handleControllerError(res, err, 404);
    }
  });

  app.delete('/api/conversations/:id/skills/:name', (req: Request, res: Response) => {
    const id = getConversationId(req);
    if (!ensureConversation(res, id)) return;

    try {
      validateSkillName(req.params.name);
    } catch {
      sendError(res, 400, ErrorCodes.INVALID_SKILL_NAME, 'Invalid skill name');
      return;
    }

    try {
      skillService.deleteSkill(id, req.params.name);
      res.status(204).send();
    } catch (err) {
      const message = (err as Error).message;
      if (isAppError(err)) {
        sendError(res, err.statusCode, err.code, err.message);
      } else if (message.includes('Skill not found')) {
        sendError(res, 404, ErrorCodes.SKILL_NOT_FOUND, message);
      } else {
        sendError(res, 500, ErrorCodes.INTERNAL_ERROR, message);
      }
    }
  });

  // Global error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('HTTP error:', err);
    const status = isAppError(err) ? err.statusCode : (err as any).status ?? (err as any).statusCode ?? 500;
    res.status(status).json(toHttpErrorResponse(err));
  });

  // ─── HTTP & WebSocket Server ───────────────────────────

  const httpServer = createServer(app);

  const wss = new WebSocketServer({ noServer: true });
  const wsRouter = new WSRouter(wss, conversationState, wsConfig, configService, agentService, skillService, conversationService, fileService, sessionService, messageService);

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
