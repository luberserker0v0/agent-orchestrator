import type { IncomingMessage } from 'node:http';
import type { WebSocket, WebSocketServer } from 'ws';
import type { ConversationState } from '../orchestrator/conversation-state.js';
import type { AgentService } from '../services/agent-service.js';
import type { ConfigService } from '../services/config-service.js';
import type { ConversationService } from '../services/conversation-service.js';
import type { FileService } from '../services/file-service.js';
import type { MessageService } from '../services/message-service.js';
import type { RoleService } from '../services/role-service.js';
import type { SessionService } from '../services/session-service.js';
import type { SkillService } from '../services/skill-service.js';
import type { ApiKeyEntry, ApiKeyRole, WebSocketConfig } from '../config-loader.js';
import { wsConnectionsActive } from '../metrics/registry.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { WSConnection } from './connection.js';
import { WSMethodDispatcher } from './method-dispatcher.js';

const WS_METHOD_PERMISSIONS: Record<string, string> = {
  'message.send': 'message:send',
  'message.history': 'message:history',
  'config.update': 'config:write', 'config.patch': 'config:write',
  'config.get': 'config:get',
  'agent.register': 'agent:write', 'agent.delete': 'agent:delete',
  'agent.list': 'agent:list', 'agent.get': 'agent:get',
  'agent.config.write': 'agent:write', 'agent.config.delete': 'agent:delete',
  'agent.config.get': 'agent:get',
  'file.write': 'file:write', 'file.delete': 'file:delete', 'file.copy': 'file:copy',
  'file.read': 'file:read', 'file.list': 'file:list',
  'session.create': 'session:create', 'session.delete': 'session:delete',
  'session.fork': 'session:fork', 'session.abort': 'session:abort',
  'session.list': 'session:list', 'session.get': 'session:get', 'session.children': 'session:children',
  'providers.list': 'provider:list',
  'skills.import': 'skill:import', 'skills.delete': 'skill:delete',
  'skills.list': 'skill:list', 'skills.get': 'skill:get', 'skills.info': 'skill:info',
  'conversation.status': 'conversation:get',
  'conversation.start': 'conversation:start', 'conversation.stop': 'conversation:stop',
  'conversation.restart': 'conversation:restart', 'conversation.delete': 'conversation:delete',
};

export class WSRouter {
  private readonly dispatcher: WSMethodDispatcher;
  private readonly connections = new Map<string, WSConnection>();
  private readonly connectionRoles = new Map<string, ApiKeyRole>();
  private readonly eventUnsubscribers = new Map<string, () => void>();

  constructor(
    private readonly wss: WebSocketServer,
    private readonly conversationState: ConversationState,
    private readonly wsConfig: WebSocketConfig,
    configService: ConfigService,
    agentService: AgentService,
    skillService: SkillService,
    conversationService: ConversationService,
    fileService: FileService,
    sessionService: SessionService,
    messageService: MessageService,
    private readonly roleService: RoleService,
    private readonly resolvedApiKeys?: ApiKeyEntry[],
    private readonly rbacEnabled = false,
  ) {
    this.dispatcher = new WSMethodDispatcher({
      conversationState,
      configService,
      agentService,
      skillService,
      conversationService,
      fileService,
      sessionService,
      messageService,
    });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
  }

  closeAll(): void {
    for (const connection of this.connections.values()) {
      connection.close(1001, 'Server shutting down');
    }
    this.connections.clear();
    for (const unsub of this.eventUnsubscribers.values()) unsub();
    this.eventUnsubscribers.clear();
    this.wss.close();
  }

  private async onConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const url = req.url ?? '';
    const pathMatch = url.match(/^\/ws\/([^/?]+)/);
    if (!pathMatch) {
      logger.warn(`WS connection rejected: invalid path ${url}`);
      ws.close(1008, 'Invalid path');
      return;
    }

    const conversationId = pathMatch[1];
    logger.info(`WS connection requested: ${conversationId}`);
    if (!this.conversationState.has(conversationId)) {
      logger.warn(`Conversation not found for ${conversationId}`);
      ws.close(1011, 'Conversation not found');
      return;
    }

    this.replaceExistingConnection(conversationId);
    const connection = new WSConnection(
      ws,
      conversationId,
      (method, params) => this.handleMessage(conversationId, method, params),
      this.wsConfig.heartbeatIntervalMs,
      this.wsConfig.idleTimeoutMs,
    );
    this.connections.set(conversationId, connection);
    this.connectionRoles.set(conversationId, this.resolveRole(url, req));
    wsConnectionsActive.inc();
    logger.info(`WS connection established: ${conversationId}`);

    for (const event of this.conversationState.getRecentEvents(conversationId)) {
      connection.sendEvent(event.type, event.payload);
    }
    const unsubscribe = this.subscribeToConversation(conversationId, connection);
    ws.on('close', () => this.onClose(conversationId, connection, unsubscribe));
  }

  private resolveRole(url: string, req: IncomingMessage): ApiKeyRole {
    if (!this.rbacEnabled) return 'admin';
    const parsedUrl = new URL(url, `http://${req.headers.host ?? 'localhost'}`);
    const token = parsedUrl.searchParams.get('apiKey')
      ?? req.headers['x-api-key'] as string | undefined;
    return this.resolvedApiKeys?.find(entry => entry.key === token)?.role ?? 'admin';
  }

  private replaceExistingConnection(conversationId: string): void {
    const existing = this.connections.get(conversationId);
    if (!existing) return;
    logger.warn(`Closing existing WS connection for ${conversationId}`);
    existing.sendEvent('connection.replaced', {});
    existing.close(1000, 'Replaced by new connection');
    this.connections.delete(conversationId);
    this.eventUnsubscribers.get(conversationId)?.();
    this.eventUnsubscribers.delete(conversationId);
  }

  private subscribeToConversation(conversationId: string, connection: WSConnection): () => void {
    const unsubscribe = this.conversationState.subscribe(conversationId, event => {
      connection.sendEvent(event.type, event.payload);
      if (event.type === 'conversation.destroyed') {
        setTimeout(() => connection.close(1000, 'Conversation deleted'), 2000);
      }
    });
    this.eventUnsubscribers.set(conversationId, unsubscribe);
    return unsubscribe;
  }

  private onClose(
    conversationId: string,
    connection: WSConnection,
    unsubscribe: () => void,
  ): void {
    wsConnectionsActive.dec();
    if (this.connections.get(conversationId) !== connection) {
      logger.info(`Replaced WS connection closed: ${conversationId}`);
      return;
    }
    this.connections.delete(conversationId);
    this.connectionRoles.delete(conversationId);
    unsubscribe();
    if (this.eventUnsubscribers.get(conversationId) === unsubscribe) {
      this.eventUnsubscribers.delete(conversationId);
    }
    logger.info(`WS connection closed: ${conversationId}`);
  }

  private async handleMessage(conversationId: string, method: string, params: unknown): Promise<unknown> {
    if (this.rbacEnabled) this.authorize(conversationId, method);
    return await this.dispatcher.dispatch(conversationId, method, params);
  }

  private authorize(conversationId: string, method: string): void {
    const permission = WS_METHOD_PERMISSIONS[method];
    if (!permission) {
      throw new AppError(400, ErrorCodes.INVALID_REQUEST_BODY, `Unknown method: ${method}`);
    }
    const role = this.connectionRoles.get(conversationId);
    if (!role || !this.roleService.hasPermission(role, permission)) {
      throw new AppError(403, ErrorCodes.FORBIDDEN, 'Insufficient permissions');
    }
  }
}
