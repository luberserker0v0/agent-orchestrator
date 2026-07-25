import { ConversationState } from './conversation-state.js';
import { OpenCodeSSEClient } from '../opencode-http/sse-client.js';
import { SSE_EVENT_MAP } from '../opencode-http/sse-types.js';
import { logger } from '../utils/logger.js';

export interface SSEBridgeOptions {
  enabled?: boolean;
  reconnectMaxAttempts?: number;
  reconnectBaseMs?: number;
  filterHeartbeat?: boolean;
}

export class SSEBridge {
  private clients = new Map<string, OpenCodeSSEClient>();
  private conversationState: ConversationState;
  private enabled: boolean;
  private filterHeartbeat: boolean;

  constructor(conversationState: ConversationState, options?: SSEBridgeOptions) {
    this.conversationState = conversationState;
    this.enabled = options?.enabled ?? true;
    this.filterHeartbeat = options?.filterHeartbeat ?? true;
  }

  start(
    id: string,
    baseUrl: string,
    username?: string,
    password?: string,
    options?: { reconnectMaxAttempts?: number; reconnectBaseMs?: number }
  ): void {
    if (!this.enabled) {
      logger.debug(`SSE bridge disabled, skipping subscription for ${id}`);
      return;
    }

    const client = new OpenCodeSSEClient({
      baseUrl,
      username,
      password,
      reconnectMaxAttempts: options?.reconnectMaxAttempts,
      reconnectBaseMs: options?.reconnectBaseMs,
    });

    client.subscribe((event) => {
      this.handleEvent(id, event);
    }).catch((err) => {
      logger.error(`SSE subscription error for ${id}: ${(err as Error).message}`);
    });

    this.clients.set(id, client);
    logger.info(`SSE subscription started for ${id}`);
  }

  stop(id: string): void {
    const client = this.clients.get(id);
    if (client) {
      client.disconnect();
      this.clients.delete(id);
      logger.info(`SSE subscription stopped for ${id}`);
    }
  }

  private handleEvent(id: string, event: { type: string; properties: Record<string, unknown> }): void {
    const aoEventType = SSE_EVENT_MAP[event.type as keyof typeof SSE_EVENT_MAP];
    if (!aoEventType) {
      return;
    }

    // Filter heartbeat events to reduce noise
    if (this.filterHeartbeat && event.type === 'server.heartbeat') {
      return;
    }

    this.conversationState.emitEvent(id, aoEventType, event.properties);
  }
}
