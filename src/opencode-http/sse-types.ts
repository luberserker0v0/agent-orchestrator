/**
 * OpenCode SSE Event Types
 * Based on OpenCode server API documentation
 * https://opencode.ai/docs/server/#events
 */

export type OpenCodeEventType =
  | 'server.connected'
  | 'server.heartbeat'
  | 'session.created'
  | 'session.updated'
  | 'message.updated'
  | 'permission.asked'
  | 'permission.replied'
  | 'file.changed';

export interface OpenCodeSSEPayload {
  directory?: string;
  payload: {
    type: OpenCodeEventType;
    properties: Record<string, unknown>;
  };
}

/**
 * Mapping from OpenCode SSE events to AgentOrchestrator ConversationEvent types
 * AO events use 'opencode.' prefix to distinguish from internal conversation events
 */
export const SSE_EVENT_MAP: Record<OpenCodeEventType, string> = {
  'server.connected': 'opencode.connected',
  'server.heartbeat': 'opencode.heartbeat',
  'session.created': 'opencode.session.created',
  'session.updated': 'opencode.session.updated',
  'message.updated': 'opencode.message.updated',
  'permission.asked': 'opencode.permission.asked',
  'permission.replied': 'opencode.permission.replied',
  'file.changed': 'opencode.file.changed',
};

export interface SSEClientOptions {
  baseUrl: string;
  username?: string;
  password?: string;
  reconnectMaxAttempts?: number;
  reconnectBaseMs?: number;
}

export interface SSEEvent {
  id?: string;
  type: string;
  properties: Record<string, unknown>;
}
