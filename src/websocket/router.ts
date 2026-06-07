import type { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import { logger } from '../utils/logger.js';
import { InstanceManager } from '../orchestrator/instance-manager.js';
import { WorkspaceFactory, validateSkillName } from '../orchestrator/workspace-factory.js';
import { ConversationState } from '../orchestrator/conversation-state.js';
import { WSConnection } from './connection.js';
import type { WebSocketConfig } from '../config-loader.js';
import type { ServerConfig } from '../config-loader.js';
import { wsConnectionsActive } from '../metrics/registry.js';

export class WSRouter {
  private wss: WebSocketServer;
  private instanceManager: InstanceManager;
  private workspaceFactory: WorkspaceFactory;
  private conversationState: ConversationState;
  private wsConfig: WebSocketConfig;
  private serverConfig: ServerConfig;
  private connections: Map<string, WSConnection> = new Map();
  private eventUnsubscribers: Map<string, () => void> = new Map();

  constructor(
    wss: WebSocketServer,
    instanceManager: InstanceManager,
    workspaceFactory: WorkspaceFactory,
    conversationState: ConversationState,
    wsConfig: WebSocketConfig,
    serverConfig: ServerConfig
  ) {
    this.wss = wss;
    this.instanceManager = instanceManager;
    this.workspaceFactory = workspaceFactory;
    this.conversationState = conversationState;
    this.wsConfig = wsConfig;
    this.serverConfig = serverConfig;

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

    // Check conversation exists
    if (!this.conversationState.has(conversationId)) {
      logger.warn(`Conversation not found for ${conversationId}`);
      ws.close(1011, 'Conversation not found');
      return;
    }

    // Close existing connection for same conversation
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
    wsConnectionsActive.inc();
    logger.info(`WS connection established: ${conversationId}`);

    // Subscribe to conversation events and push to client
    const unsub = this.conversationState.subscribe(conversationId, (event) => {
      connection.sendEvent(event.type, event.payload);
    });
    this.eventUnsubscribers.set(conversationId, unsub);

    ws.on('close', () => {
      this.connections.delete(conversationId);
      this.eventUnsubscribers.get(conversationId)?.();
      this.eventUnsubscribers.delete(conversationId);
      wsConnectionsActive.dec();
      logger.info(`WS connection closed: ${conversationId}`);
    });
  }

  private async handleMessage(conversationId: string, method: string, params: unknown): Promise<unknown> {
    const state = this.conversationState.get(conversationId);
    if (!state) {
      throw new Error('Conversation not found');
    }

    // Session-scoped methods require running instance
    const needsRunning = ['message.send', 'message.history', 'session.create', 'session.abort'].includes(method);
    if (needsRunning) {
      if (state.status !== 'running') {
        throw new Error(`Conversation is not running (status: ${state.status})`);
      }
    }

    const instance = this.instanceManager.getInstance(conversationId);

    switch (method) {
      case 'message.send': {
        if (!instance) throw new Error('Instance not available');
        const { text, model: rawModel, agent: rawAgent } = params as { text: string; model?: string; agent?: string };
        if (!text) throw new Error('Missing text parameter');

        let model: { providerID: string; modelID: string } | undefined;
        const modelStr = rawModel;
        if (modelStr) {
          const parts = modelStr.split('/');
          if (parts.length >= 2) {
            model = { providerID: parts[0], modelID: parts.slice(1).join('/') };
          }
        }

        const agent = rawAgent;

        const response = await instance.client.sendPrompt(instance.sessionId, {
          model,
          agent,
          parts: [{ type: 'text', text }],
        });
        const texts = response.parts
          .filter((p) => p.type === 'text')
          .map((p) => (p as { text: string }).text)
          .join('');
        return { messageId: response.info.id, text: texts, parts: response.parts };
      }

      case 'message.history': {
        if (!instance) throw new Error('Instance not available');
        const { limit } = params as { limit?: number };
        const messages = await instance.client.listMessages(instance.sessionId, limit);
        return messages;
      }

      case 'session.abort': {
        if (!instance) throw new Error('Instance not available');
        const result = await instance.client.abortSession(instance.sessionId);
        return { aborted: result };
      }

      // ─── Config ──────────────────────────────────────────

      case 'config.patch': {
        const { config } = params as { config: Record<string, unknown> };
        if (typeof config !== 'object' || config === null) {
          throw new Error('Missing or invalid config');
        }
        this.workspaceFactory.writeConfig(conversationId, config);
        if (state.status === 'running') {
          this.conversationState.markNeedsRestart(conversationId, 'opencode.json changed');
        }
        this.conversationState.emitEvent(conversationId, 'conversation.configChanged', {
          changedFiles: ['.opencode/opencode.json'],
        });
        return { patched: true };
      }

      case 'config.get': {
        return this.workspaceFactory.readConfig(conversationId);
      }

      // ─── Agents ──────────────────────────────────────────

      case 'agent.register': {
        const { name, content } = params as { name: string; content: string };
        if (!name || content === undefined) throw new Error('Missing name or content');
        this.workspaceFactory.writeAgent(conversationId, name, content);
        if (state.status === 'running') {
          this.conversationState.markNeedsRestart(conversationId, `agent ${name} updated`);
        }
        this.conversationState.emitEvent(conversationId, 'conversation.configChanged', {
          changedFiles: [`.opencode/agents/${name}.md`],
        });
        return { registered: name };
      }

      case 'agent.list': {
        return this.workspaceFactory.listAgents(conversationId);
      }

      case 'agent.get': {
        const { name } = params as { name: string };
        if (!name) throw new Error('Missing name');
        return this.workspaceFactory.readAgent(conversationId, name);
      }

      case 'agent.delete': {
        const { name } = params as { name: string };
        if (!name) throw new Error('Missing name');
        this.workspaceFactory.deleteAgent(conversationId, name);
        if (state.status === 'running') {
          this.conversationState.markNeedsRestart(conversationId, `agent ${name} deleted`);
        }
        this.conversationState.emitEvent(conversationId, 'conversation.configChanged', {
          changedFiles: [`.opencode/agents/${name}.md`],
        });
        return { deleted: name };
      }

      // ─── AGENTS.md ─────────────────────────────────────────

      case 'agent.config.write': {
        const { content } = params as { content: string };
        if (content === undefined) throw new Error('Missing content');
        this.workspaceFactory.writeAgentsMd(conversationId, content);
        if (state.status === 'running') {
          this.conversationState.markNeedsRestart(conversationId, 'AGENTS.md updated');
        }
        this.conversationState.emitEvent(conversationId, 'conversation.configChanged', {
          changedFiles: ['AGENTS.md'],
        });
        return { written: true };
      }

      case 'agent.config.get': {
        return this.workspaceFactory.readAgentsMd(conversationId);
      }

      case 'agent.config.delete': {
        this.workspaceFactory.deleteAgentsMd(conversationId);
        if (state.status === 'running') {
          this.conversationState.markNeedsRestart(conversationId, 'AGENTS.md deleted');
        }
        this.conversationState.emitEvent(conversationId, 'conversation.configChanged', {
          changedFiles: ['AGENTS.md'],
        });
        return { deleted: true };
      }

      // ─── Files ───────────────────────────────────────────

      case 'file.write': {
        const { path, content } = params as { path: string; content: string };
        if (path === undefined || content === undefined) throw new Error('Missing path or content');
        this.workspaceFactory.writeFile(conversationId, path, content);
        if (state.status === 'running') {
          this.conversationState.markNeedsRestart(conversationId, `file ${path} updated`);
        }
        return { written: path };
      }

      case 'file.read': {
        const { path } = params as { path: string };
        if (path === undefined) throw new Error('Missing path');
        return this.workspaceFactory.readFile(conversationId, path);
      }

      case 'file.delete': {
        const { path } = params as { path: string };
        if (path === undefined) throw new Error('Missing path');
        this.workspaceFactory.deleteFile(conversationId, path);
        return { deleted: path };
      }

      case 'file.list': {
        const { path } = params as { path?: string };
        return this.workspaceFactory.listFiles(conversationId, path);
      }

      case 'file.copy': {
        const { source, dest } = params as { source: string; dest: string };
        if (!source || !dest) throw new Error('Missing source or dest');
        this.workspaceFactory.copyFromLocal(conversationId, source, dest);
        if (state.status === 'running') {
          this.conversationState.markNeedsRestart(conversationId, `file copied to ${dest}`);
        }
        return { copied: dest };
      }

      // ─── Sessions ────────────────────────────────────────

      case 'session.create': {
        if (!instance) throw new Error('Instance not available');
        const { title, parentID } = params as { title?: string; parentID?: string };
        return await instance.client.createSession({ title, parentID });
      }

      case 'session.list': {
        if (!instance) throw new Error('Instance not available');
        return await instance.client.listSessions();
      }

      case 'session.get': {
        if (!instance) throw new Error('Instance not available');
        const { sessionId } = params as { sessionId: string };
        if (!sessionId) throw new Error('Missing sessionId');
        return await instance.client.getSession(sessionId);
      }

      case 'session.children': {
        if (!instance) throw new Error('Instance not available');
        const { sessionId } = params as { sessionId: string };
        if (!sessionId) throw new Error('Missing sessionId');
        return await instance.client.getSessionChildren(sessionId);
      }

      case 'session.fork': {
        if (!instance) throw new Error('Instance not available');
        const { sessionId, messageID } = params as { sessionId: string; messageID?: string };
        if (!sessionId) throw new Error('Missing sessionId');
        return await instance.client.forkSession(sessionId, messageID);
      }

      case 'session.delete': {
        if (!instance) throw new Error('Instance not available');
        const { sessionId } = params as { sessionId: string };
        if (!sessionId) throw new Error('Missing sessionId');
        await instance.client.deleteSession(sessionId);
        return { deleted: sessionId };
      }

      // ─── Skills ────────────────────────────────────────────

      case 'skills.import': {
        const { source, name } = params as { source: string; name: string };
        if (!source || !name) throw new Error('Missing source or name');
        validateSkillName(name);
        this.workspaceFactory.importSkillFromLocal(conversationId, source, name);
        if (state.status === 'running') {
          this.conversationState.markNeedsRestart(conversationId, `skill ${name} imported`);
        }
        this.conversationState.emitEvent(conversationId, 'conversation.configChanged', {
          changedFiles: [`.opencode/skills/${name}/`],
        });
        return { imported: name };
      }

      case 'skills.list': {
        return this.workspaceFactory.listSkills(conversationId);
      }

      case 'skills.get': {
        const { name } = params as { name: string };
        if (!name) throw new Error('Missing name');
        validateSkillName(name);
        return this.workspaceFactory.readSkill(conversationId, name);
      }

      case 'skills.info': {
        const { name } = params as { name: string };
        if (!name) throw new Error('Missing name');
        validateSkillName(name);
        return this.workspaceFactory.getSkillInfo(conversationId, name);
      }

      case 'skills.delete': {
        const { name } = params as { name: string };
        if (!name) throw new Error('Missing name');
        validateSkillName(name);
        this.workspaceFactory.deleteSkill(conversationId, name);
        if (state.status === 'running') {
          this.conversationState.markNeedsRestart(conversationId, `skill ${name} deleted`);
        }
        this.conversationState.emitEvent(conversationId, 'conversation.configChanged', {
          changedFiles: [`.opencode/skills/${name}/`],
        });
        return { deleted: name };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }
}
