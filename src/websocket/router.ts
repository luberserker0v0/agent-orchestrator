import type { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import { logger } from '../utils/logger.js';
import { InstanceManager } from '../orchestrator/instance-manager.js';
import { WSConnection } from './connection.js';
import type { WebSocketConfig } from '../config-loader.js';
import { wsConnectionsActive } from '../metrics/registry.js';

export class WSRouter {
  private wss: WebSocketServer;
  private instanceManager: InstanceManager;
  private wsConfig: WebSocketConfig;
  private connections: Map<string, WSConnection> = new Map();

  constructor(wss: WebSocketServer, instanceManager: InstanceManager, wsConfig: WebSocketConfig) {
    this.wss = wss;
    this.instanceManager = instanceManager;
    this.wsConfig = wsConfig;

    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
  }

  closeAll(): void {
    for (const connection of this.connections.values()) {
      connection.close(1001, 'Server shutting down');
    }
    this.connections.clear();
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

    // Ensure instance exists (or create if not)
    let instance = this.instanceManager.getInstance(conversationId);
    if (!instance) {
      logger.warn(`Instance not found for ${conversationId}, creating new instance`);
      try {
        instance = await this.instanceManager.createInstance(conversationId);
      } catch (err) {
        logger.error(`Failed to create instance for ${conversationId}:`, err);
        ws.close(1011, 'Failed to create conversation instance');
        return;
      }
    }

    // Close existing connection for same conversation
    const existing = this.connections.get(conversationId);
    if (existing) {
      logger.warn(`Closing existing WS connection for ${conversationId}`);
      existing.sendEvent('connection.replaced', {});
      existing.close(1000, 'Replaced by new connection');
      this.connections.delete(conversationId);
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

    ws.on('close', () => {
      this.connections.delete(conversationId);
      wsConnectionsActive.dec();
      logger.info(`WS connection closed: ${conversationId}`);
    });
  }

  private async handleMessage(conversationId: string, method: string, params: unknown): Promise<unknown> {
    const instance = this.instanceManager.getInstance(conversationId);
    if (!instance) {
      throw new Error('Conversation instance not available');
    }

    switch (method) {
      case 'message.send': {
        const { text, model: rawModel, agent: rawAgent } = params as { text: string; model?: string; agent?: string };
        if (!text) throw new Error('Missing text parameter');

        // Resolve model: use provided string, fallback to instance default, or leave undefined
        let model: { providerID: string; modelID: string } | undefined;
        const modelStr = rawModel ?? instance.defaultModel;
        if (modelStr) {
          const parts = modelStr.split('/');
          if (parts.length >= 2) {
            model = { providerID: parts[0], modelID: parts.slice(1).join('/') };
          }
        }

        // Resolve agent: use provided string or fallback to instance default
        const agent = rawAgent ?? instance.defaultAgent;

        const response = await instance.client.sendPrompt(instance.sessionId, {
          model,
          agent,
          parts: [{ type: 'text', text }],
        });
        // Extract text parts from response
        const texts = response.parts
          .filter((p) => p.type === 'text')
          .map((p) => (p as { text: string }).text)
          .join('');
        return { messageId: response.info.id, text: texts, parts: response.parts };
      }

      case 'message.history': {
        const { limit } = params as { limit?: number };
        const messages = await instance.client.listMessages(instance.sessionId, limit);
        return messages;
      }

      case 'session.abort': {
        const result = await instance.client.abortSession(instance.sessionId);
        return { aborted: result };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }
}
