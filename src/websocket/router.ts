import type { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import { logger } from '../utils/logger.js';
import { ConversationState } from '../orchestrator/conversation-state.js';
import { ConfigService } from '../services/config-service.js';
import { AgentService } from '../services/agent-service.js';
import { SkillService } from '../services/skill-service.js';
import { ConversationService } from '../services/conversation-service.js';
import { FileService } from '../services/file-service.js';
import { SessionService } from '../services/session-service.js';
import { MessageService } from '../services/message-service.js';
import { WSConnection } from './connection.js';
import type { WebSocketConfig, ApiKeyEntry, ApiKeyRole } from '../config-loader.js';
import { wsConnectionsActive } from '../metrics/registry.js';
import { validateSkillName, validateAgentName } from '../orchestrator/workspace-factory.js';
import { AppError, ErrorCodes } from '../utils/errors.js';

const WRITE_METHODS = new Set([
  'message.send',
  'config.update', 'config.patch',
  'agent.register', 'agent.delete',
  'agent.config.write', 'agent.config.delete',
  'file.write', 'file.delete', 'file.copy',
  'session.create', 'session.delete', 'session.fork', 'session.abort',
  'skills.import', 'skills.delete',
  'conversation.start', 'conversation.stop', 'conversation.restart', 'conversation.delete',
]);

export class WSRouter {
  private wss: WebSocketServer;
  private conversationState: ConversationState;
  private wsConfig: WebSocketConfig;
  private configService: ConfigService;
  private agentService: AgentService;
  private skillService: SkillService;
  private conversationService: ConversationService;
  private fileService: FileService;
  private sessionService: SessionService;
  private messageService: MessageService;
  private resolvedApiKeys?: ApiKeyEntry[];
  private connections: Map<string, WSConnection> = new Map();
  private connectionRoles: Map<string, ApiKeyRole> = new Map();
  private eventUnsubscribers: Map<string, () => void> = new Map();

  constructor(
    wss: WebSocketServer,
    conversationState: ConversationState,
    wsConfig: WebSocketConfig,
    configService: ConfigService,
    agentService: AgentService,
    skillService: SkillService,
    conversationService: ConversationService,
    fileService: FileService,
    sessionService: SessionService,
    messageService: MessageService,
    resolvedApiKeys?: ApiKeyEntry[]
  ) {
    this.wss = wss;
    this.conversationState = conversationState;
    this.wsConfig = wsConfig;
    this.configService = configService;
    this.agentService = agentService;
    this.skillService = skillService;
    this.conversationService = conversationService;
    this.fileService = fileService;
    this.sessionService = sessionService;
    this.messageService = messageService;
    this.resolvedApiKeys = resolvedApiKeys;

    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
  }

  closeAll(): void {
    for (const connection of this.connections.values()) {
      connection.close(1001, 'Server shutting down');
    }
    this.connections.clear();
    for (const unsub of this.eventUnsubscribers.values()) {
      unsub();
    }
    this.eventUnsubscribers.clear();
    this.wss.close();
  }

  private async onConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const url = req.url ?? '';
    const match = url.match(/^\/ws\/([^/]+)$/);
    if (!match) {
      logger.warn(`WS connection rejected: invalid path ${url}`);
      ws.close(1008, 'Invalid path');
      return;
    }

    const conversationId = match[1];
    logger.info(`WS connection requested: ${conversationId}`);

    // Extract role from apiKey
    let role: ApiKeyRole = 'admin';
    if (this.resolvedApiKeys && this.resolvedApiKeys.length > 0) {
      const parsedUrl = new URL(url, `http://${req.headers.host ?? 'localhost'}`);
      const token = parsedUrl.searchParams.get('apiKey')
        ?? req.headers['x-api-key'] as string | undefined;
      const match = this.resolvedApiKeys.find(e => e.key === token);
      role = match?.role ?? 'admin';
    }

    if (!this.conversationState.has(conversationId)) {
      logger.warn(`Conversation not found for ${conversationId}`);
      ws.close(1011, 'Conversation not found');
      return;
    }

    const existing = this.connections.get(conversationId);
    if (existing) {
      logger.warn(`Closing existing WS connection for ${conversationId}`);
      existing.sendEvent('connection.replaced', {});
      existing.close(1000, 'Replaced by new connection');
      this.connections.delete(conversationId);
      this.eventUnsubscribers.get(conversationId)?.();
      this.eventUnsubscribers.delete(conversationId);
    }

    const connection = new WSConnection(
      ws,
      conversationId,
      (method, params) => this.handleMessage(conversationId, method, params),
      this.wsConfig.heartbeatIntervalMs,
      this.wsConfig.idleTimeoutMs
    );

    this.connections.set(conversationId, connection);
    this.connectionRoles.set(conversationId, role);
    wsConnectionsActive.inc();
    logger.info(`WS connection established: ${conversationId}`);

    const unsub = this.conversationState.subscribe(conversationId, (event) => {
      connection.sendEvent(event.type, event.payload);
      if (event.type === 'conversation.destroyed') {
        setTimeout(() => connection.close(1000, 'Conversation deleted'), 2000);
      }
    });
    this.eventUnsubscribers.set(conversationId, unsub);

    ws.on('close', () => {
      this.connections.delete(conversationId);
      this.connectionRoles.delete(conversationId);
      this.eventUnsubscribers.get(conversationId)?.();
      this.eventUnsubscribers.delete(conversationId);
      wsConnectionsActive.dec();
      logger.info(`WS connection closed: ${conversationId}`);
    });
  }

  private async handleMessage(conversationId: string, method: string, params: unknown): Promise<unknown> {
    const role = this.connectionRoles.get(conversationId);
    if (role === 'observer' && WRITE_METHODS.has(method)) {
      throw new AppError(403, ErrorCodes.FORBIDDEN, 'Insufficient permissions');
    }

    switch (method) {

      // ─── Message ───────────────────────────────────────────

      case 'message.send': {
        const { text, model: rawModel, agent: rawAgent } = params as { text: string; model?: string; agent?: string };
        if (!text) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing text parameter');
        return await this.messageService.send(conversationId, text, rawModel, rawAgent);
      }

      case 'message.history': {
        const { sessionId, limit } = params as { sessionId?: string; limit?: number };
        return await this.messageService.getHistory(conversationId, sessionId, limit);
      }

      // ─── Config ──────────────────────────────────────────

      case 'config.update': {
        const { config } = params as { config: Record<string, unknown> };
        if (typeof config !== 'object' || config === null) {
          throw new AppError(400, ErrorCodes.INVALID_REQUEST_BODY, 'Missing or invalid config');
        }
        this.configService.writeConfig(conversationId, config);
        return { updated: true };
      }

      case 'config.get': {
        return this.configService.readConfig(conversationId);
      }

      case 'config.patch': {
        const { config: patch } = params as { config: Record<string, unknown> };
        if (typeof patch !== 'object' || patch === null) {
          throw new AppError(400, ErrorCodes.INVALID_REQUEST_BODY, 'Missing or invalid config patch');
        }
        this.configService.patchConfig(conversationId, patch);
        return { updated: true };
      }

      // ─── Agents ──────────────────────────────────────────

      case 'agent.register': {
        const { name, content } = params as { name: string; content: string };
        if (!name || content === undefined) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing name or content');
        this.agentService.writeAgent(conversationId, name, content);
        return { registered: name };
      }

      case 'agent.list': {
        return await this.agentService.listAgentsWithRuntime(conversationId);
      }

      case 'agent.get': {
        const { name } = params as { name: string };
        if (!name) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing name');
        return this.agentService.readAgent(conversationId, name);
      }

      case 'agent.delete': {
        const { name } = params as { name: string };
        if (!name) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing name');
        this.agentService.deleteAgent(conversationId, name);
        return { deleted: name };
      }

      // ─── AGENTS.md ─────────────────────────────────────────

      case 'agent.config.write': {
        const { content } = params as { content: string };
        if (content === undefined) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing content');
        this.agentService.writeAgentsMd(conversationId, content);
        return { written: true };
      }

      case 'agent.config.get': {
        return this.agentService.readAgentsMd(conversationId);
      }

      case 'agent.config.delete': {
        this.agentService.deleteAgentsMd(conversationId);
        return { deleted: true };
      }

      // ─── Files ───────────────────────────────────────────

      case 'file.write': {
        const { path, content } = params as { path: string; content: string };
        if (path === undefined || content === undefined) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing path or content');
        this.fileService.write(conversationId, path, content);
        return { written: path };
      }

      case 'file.read': {
        const { path } = params as { path: string };
        if (path === undefined) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing path');
        return this.fileService.read(conversationId, path);
      }

      case 'file.delete': {
        const { path } = params as { path: string };
        if (path === undefined) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing path');
        this.fileService.delete(conversationId, path);
        return { deleted: path };
      }

      case 'file.list': {
        const { path } = params as { path?: string };
        return this.fileService.list(conversationId, path);
      }

      case 'file.copy': {
        const { source, dest } = params as { source: string; dest: string };
        if (!source || !dest) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing source or dest');
        this.fileService.copy(conversationId, source, dest);
        return { copied: dest };
      }

      // ─── Sessions ────────────────────────────────────────

      case 'session.create': {
        const opts = params as { title?: string; parentID?: string } | undefined;
        return await this.sessionService.create(conversationId, opts);
      }

      case 'session.list': {
        return await this.sessionService.list(conversationId);
      }

      case 'session.get': {
        const { sessionId } = params as { sessionId: string };
        if (!sessionId) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing sessionId');
        return await this.sessionService.get(conversationId, sessionId);
      }

      case 'session.children': {
        const { sessionId } = params as { sessionId: string };
        if (!sessionId) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing sessionId');
        return await this.sessionService.getChildren(conversationId, sessionId);
      }

      case 'session.fork': {
        const { sessionId, messageID } = params as { sessionId: string; messageID?: string };
        if (!sessionId) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing sessionId');
        return await this.sessionService.fork(conversationId, sessionId, messageID);
      }

      case 'session.delete': {
        const { sessionId } = params as { sessionId: string };
        if (!sessionId) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing sessionId');
        await this.sessionService.delete(conversationId, sessionId);
        return { deleted: sessionId };
      }

      case 'session.abort': {
        return await this.sessionService.abort(conversationId);
      }

      // ─── Providers ─────────────────────────────────────────

      case 'providers.list': {
        return await this.sessionService.listProviders(conversationId);
      }

      // ─── Skills ────────────────────────────────────────────

      case 'skills.import': {
        const { source, name, agent } = params as { source: string; name: string; agent?: string };
        if (!source || !name) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing source or name');
        let agentName: string | undefined;
        if (agent) {
          try { agentName = validateAgentName(agent); } catch { throw new AppError(400, ErrorCodes.INVALID_AGENT_NAME, 'Invalid agent name'); }
        }
        this.skillService.importSkill(conversationId, source, name, agentName);
        return { imported: name };
      }

      case 'skills.list': {
        const { agent } = params as { agent?: string };
        let agentName: string | undefined;
        if (agent) {
          try { agentName = validateAgentName(agent); } catch { throw new AppError(400, ErrorCodes.INVALID_AGENT_NAME, 'Invalid agent name'); }
        }
        return this.skillService.listSkills(conversationId, agentName);
      }

      case 'skills.get': {
        const { name, agent } = params as { name: string; agent?: string };
        if (!name) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing name');
        try { validateSkillName(name); } catch { throw new AppError(400, ErrorCodes.INVALID_SKILL_NAME, 'Invalid skill name'); }
        let agentName: string | undefined;
        if (agent) {
          try { agentName = validateAgentName(agent); } catch { throw new AppError(400, ErrorCodes.INVALID_AGENT_NAME, 'Invalid agent name'); }
        }
        return this.skillService.readSkill(conversationId, name, agentName);
      }

      case 'skills.info': {
        const { name, agent } = params as { name: string; agent?: string };
        if (!name) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing name');
        try { validateSkillName(name); } catch { throw new AppError(400, ErrorCodes.INVALID_SKILL_NAME, 'Invalid skill name'); }
        let agentName: string | undefined;
        if (agent) {
          try { agentName = validateAgentName(agent); } catch { throw new AppError(400, ErrorCodes.INVALID_AGENT_NAME, 'Invalid agent name'); }
        }
        return this.skillService.getSkillInfo(conversationId, name, agentName);
      }

      case 'skills.delete': {
        const { name, agent } = params as { name: string; agent?: string };
        if (!name) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing name');
        try { validateSkillName(name); } catch { throw new AppError(400, ErrorCodes.INVALID_SKILL_NAME, 'Invalid skill name'); }
        let agentName: string | undefined;
        if (agent) {
          try { agentName = validateAgentName(agent); } catch { throw new AppError(400, ErrorCodes.INVALID_AGENT_NAME, 'Invalid agent name'); }
        }
        this.skillService.deleteSkill(conversationId, name, agentName);
        return { deleted: name };
      }

      // ─── Conversation Lifecycle ──────────────────────────

      case 'conversation.status': {
        const data = this.conversationService.get(conversationId);
        const state = this.conversationState.get(conversationId);
        return {
          ...data,
          lastError: state?.lastError,
        };
      }

      case 'conversation.start': {
        return await this.conversationService.start(conversationId);
      }

      case 'conversation.stop': {
        await this.conversationService.stop(conversationId);
        return { status: 'stopped' };
      }

      case 'conversation.restart': {
        return await this.conversationService.restart(conversationId);
      }

      case 'conversation.delete': {
        await this.conversationService.delete(conversationId);
        return { deleted: true };
      }

      default:
        throw new AppError(400, ErrorCodes.INTERNAL_ERROR, `Unknown method: ${method}`);
    }
  }
}
