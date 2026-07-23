import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSEBridge } from './sse-bridge.js';
import { ConversationState } from './conversation-state.js';

const { mockDisconnectFn, mockSubscribeFn } = vi.hoisted(() => ({
  mockDisconnectFn: vi.fn(),
  mockSubscribeFn: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../opencode-http/sse-client.js', () => ({
  OpenCodeSSEClient: class {
    subscribe = mockSubscribeFn;
    disconnect = mockDisconnectFn;
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('SSEBridge', () => {
  let bridge: SSEBridge;
  let conversationState: ConversationState;

  beforeEach(() => {
    conversationState = new ConversationState();
    bridge = new SSEBridge(conversationState);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('start', () => {
    it('subscribes to SSE events', () => {
      bridge.start('conv-1', 'http://localhost:3000', 'user', 'pass');
      expect(mockSubscribeFn).toHaveBeenCalled();
    });

    it('does not start when disabled', () => {
      const disabledBridge = new SSEBridge(conversationState, { enabled: false });
      disabledBridge.start('conv-1', 'http://localhost:3000');
      expect(mockSubscribeFn).not.toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('disconnects client', () => {
      bridge.start('conv-1', 'http://localhost:3000');
      bridge.stop('conv-1');
      expect(mockDisconnectFn).toHaveBeenCalled();
    });

    it('does nothing for unknown id', () => {
      bridge.stop('unknown-id');
    });
  });

  describe('event mapping', () => {
    it('maps OpenCode events to AO events', () => {
      conversationState.create('conv-1');
      bridge.start('conv-1', 'http://localhost:3000');

      const callback = mockSubscribeFn.mock.calls[0][0];
      callback({
        type: 'session.created',
        properties: { session: { id: 'ses_1' } },
      });

      const events = conversationState.getRecentEvents('conv-1').filter((e) => e.type.startsWith('opencode.'));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('opencode.session.created');
      expect(events[0].payload).toEqual({ session: { id: 'ses_1' } });
    });

    it('filters heartbeat events when enabled', () => {
      conversationState.create('conv-1');
      bridge.start('conv-1', 'http://localhost:3000');

      const callback = mockSubscribeFn.mock.calls[0][0];
      callback({
        type: 'server.heartbeat',
        properties: { timestamp: Date.now() },
      });

      const events = conversationState.getRecentEvents('conv-1').filter((e) => e.type.startsWith('opencode.'));
      expect(events).toHaveLength(0);
    });

    it('includes heartbeat events when filterHeartbeat is false', () => {
      const noFilterBridge = new SSEBridge(conversationState, { filterHeartbeat: false });
      conversationState.create('conv-1');
      noFilterBridge.start('conv-1', 'http://localhost:3000');

      const callback = mockSubscribeFn.mock.calls[0][0];
      callback({
        type: 'server.heartbeat',
        properties: { timestamp: Date.now() },
      });

      const events = conversationState.getRecentEvents('conv-1').filter((e) => e.type.startsWith('opencode.'));
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('opencode.heartbeat');
    });

    it('ignores unknown event types', () => {
      conversationState.create('conv-1');
      bridge.start('conv-1', 'http://localhost:3000');

      const callback = mockSubscribeFn.mock.calls[0][0];
      callback({
        type: 'unknown.event',
        properties: { data: 'test' },
      });

      const events = conversationState.getRecentEvents('conv-1').filter((e) => e.type.startsWith('opencode.'));
      expect(events).toHaveLength(0);
    });
  });
});
