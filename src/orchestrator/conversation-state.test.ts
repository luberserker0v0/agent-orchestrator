import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConversationState } from './conversation-state.js';

describe('ConversationState', () => {
  it('should create a prepared conversation', () => {
    const state = new ConversationState();
    const data = state.create('conv-001', 'opencode', 'ws://localhost:8080/ws/conv-001');

    expect(data.id).toBe('conv-001');
    expect(data.status).toBe('prepared');
    expect(data.wsUrl).toBe('ws://localhost:8080/ws/conv-001');
    expect(data.needsRestart).toBe(false);
    expect(data.events).toHaveLength(1);
    expect(data.events[0].type).toBe('conversation.prepared');
  });

  it('should transition through states', () => {
    const state = new ConversationState();
    state.create('conv-002');

    state.transition('conv-002', 'starting');
    expect(state.get('conv-002')?.status).toBe('starting');

    state.transition('conv-002', 'running', { port: 30000 });
    expect(state.get('conv-002')?.status).toBe('running');
    expect(state.get('conv-002')?.events).toHaveLength(3);
  });

  it('should not allow invalid transitions', () => {
    const state = new ConversationState();
    state.create('conv-003');
    state.transition('conv-003', 'starting');
    state.transition('conv-003', 'running');

    state.transition('conv-003', 'prepared');
    expect(state.get('conv-003')?.status).toBe('running');
  });

  it('should mark needsRestart', () => {
    const state = new ConversationState();
    state.create('conv-004');
    state.markNeedsRestart('conv-004', 'config changed');

    expect(state.get('conv-004')?.needsRestart).toBe(true);
    expect(state.get('conv-004')?.events.some((e) => e.type === 'conversation.needsRestart')).toBe(true);
  });

  it('should set instance info', () => {
    const state = new ConversationState();
    state.create('conv-005');
    state.setInstanceInfo('conv-005', { port: 30001, sessionId: 'ses_1' });

    expect(state.get('conv-005')?.port).toBe(30001);
    expect(state.get('conv-005')?.sessionId).toBe('ses_1');
  });

  it('should manage running instance references', () => {
    const state = new ConversationState();
    const mockProcess = { pid: 123 } as any;
    const mockClient = {} as any;

    state.setRunningInstance('conv-006', { process: mockProcess, client: mockClient });
    expect(state.getRunningInstance('conv-006')?.process).toBe(mockProcess);

    state.removeRunningInstance('conv-006');
    expect(state.getRunningInstance('conv-006')).toBeUndefined();
  });

  it('should emit events to subscribers', () => {
    const state = new ConversationState();
    const handler = vi.fn();
    state.create('conv-007');
    state.subscribe('conv-007', handler);

    state.transition('conv-007', 'starting');
    expect(handler).toHaveBeenCalled();
    expect(handler.mock.calls[0][0].type).toBe('conversation.starting');
  });

  it('should return recent events', () => {
    const state = new ConversationState();
    state.create('conv-008');
    state.transition('conv-008', 'starting');
    state.transition('conv-008', 'running');

    const recent = state.getRecentEvents('conv-008', 2);
    expect(recent).toHaveLength(2);
  });

  it('should list all conversations', () => {
    const state = new ConversationState();
    state.create('a');
    state.create('b');
    expect(state.list()).toHaveLength(2);
  });

  it('should remove a conversation', () => {
    const state = new ConversationState();
    state.create('conv-009');
    state.remove('conv-009');
    expect(state.get('conv-009')).toBeUndefined();
  });

  it('should have ready=false for new conversations', () => {
    const state = new ConversationState();
    const data = state.create('conv-010');
    expect(data.ready).toBe(false);
  });

  it('should cancel ready check on remove', () => {
    const state = new ConversationState();
    state.create('conv-011');
    const mockClient = { getSession: vi.fn(), health: vi.fn() };
    state.setRunningInstance('conv-011', { process: {} as any, client: mockClient as any });
    state.setInstanceInfo('conv-011', { sessionId: 'ses_1' });
    state.startReadyCheck('conv-011');
    expect(state.get('conv-011')?.ready).toBe(true);
    state.remove('conv-011');
    expect(state.get('conv-011')).toBeUndefined();
  });

  describe('has', () => {
    it('should return true for existing conversation', () => {
      const state = new ConversationState();
      state.create('conv-has');
      expect(state.has('conv-has')).toBe(true);
    });

    it('should return false for non-existent conversation', () => {
      const state = new ConversationState();
      expect(state.has('conv-nonexist')).toBe(false);
    });
  });

  describe('transition edge cases', () => {
    it('should silently ignore transition for non-existent conversation', () => {
      const state = new ConversationState();
      state.transition('nonexistent', 'starting');
    });

    it('should allow error transition from any state', () => {
      const state = new ConversationState();
      state.create('conv-err-always');
      state.transition('conv-err-always', 'running');
      state.transition('conv-err-always', 'error', { error: 'something failed' });
      expect(state.get('conv-err-always')?.status).toBe('error');
      expect(state.get('conv-err-always')?.lastError).toBe('something failed');
    });

    it('should allow same-status transition without change', () => {
      const state = new ConversationState();
      state.create('conv-same');
      state.transition('conv-same', 'starting');
      state.transition('conv-same', 'starting');
      expect(state.get('conv-same')?.status).toBe('starting');
    });
  });

  describe('markNeedsRestart / clearNeedsRestart', () => {
    it('should silently ignore markNeedsRestart for non-existent conversation', () => {
      const state = new ConversationState();
      state.markNeedsRestart('nonexistent', 'test');
    });

    it('should silently ignore clearNeedsRestart for non-existent conversation', () => {
      const state = new ConversationState();
      state.clearNeedsRestart('nonexistent');
    });

    it('should clear needsRestart flag', () => {
      const state = new ConversationState();
      state.create('conv-clear');
      state.markNeedsRestart('conv-clear', 'config changed');
      expect(state.get('conv-clear')?.needsRestart).toBe(true);
      state.clearNeedsRestart('conv-clear');
      expect(state.get('conv-clear')?.needsRestart).toBe(false);
    });
  });

  describe('setInstanceInfo edge cases', () => {
    it('should silently ignore setInstanceInfo for non-existent conversation', () => {
      const state = new ConversationState();
      state.setInstanceInfo('nonexistent', { port: 3000 });
    });

    it('should partially update instance info', () => {
      const state = new ConversationState();
      state.create('conv-partial');
      state.setInstanceInfo('conv-partial', { port: 3000 });
      expect(state.get('conv-partial')?.port).toBe(3000);
      expect(state.get('conv-partial')?.sessionId).toBeUndefined();
    });
  });

  describe('getRecentEvents edge cases', () => {
    it('should return empty array for non-existent conversation', () => {
      const state = new ConversationState();
      expect(state.getRecentEvents('nonexistent')).toEqual([]);
    });
  });

  describe('subscribe cleanup', () => {
    it('should unsubscribe the callback', () => {
      const state = new ConversationState();
      const handler = vi.fn();
      state.create('conv-unsub');
      const unsubscribe = state.subscribe('conv-unsub', handler);
      unsubscribe();
      state.transition('conv-unsub', 'starting');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('emitEvent edge cases', () => {
    it('should silently ignore emitEvent for non-existent conversation', () => {
      const state = new ConversationState();
      state.emitEvent('nonexistent', 'test', {});
    });

    it('should limit events to MAX_EVENTS', () => {
      const state = new ConversationState();
      state.create('conv-max');
      for (let i = 0; i < 150; i++) {
        state.emitEvent('conv-max', 'test.event', { index: i });
      }
      const events = state.get('conv-max')!.events;
      expect(events.length).toBeLessThanOrEqual(100);
      expect(events[0].payload.index).toBe(50);
    });

    it('should handle listener that throws', () => {
      const state = new ConversationState();
      const throwingHandler = vi.fn().mockImplementation(() => {
        throw new Error('listener error');
      });
      state.create('conv-throw');
      state.subscribe('conv-throw', throwingHandler);
      expect(() => state.transition('conv-throw', 'starting')).not.toThrow();
      expect(throwingHandler).toHaveBeenCalled();
    });
  });

  describe('remove cleanup', () => {
    it('should clean up instance info and listeners on remove', () => {
      const state = new ConversationState();
      state.create('conv-clean');
      const mockProcess = { pid: 456 } as any;
      const mockClient = {} as any;
      state.setRunningInstance('conv-clean', { process: mockProcess, client: mockClient });
      state.remove('conv-clean');
      expect(state.getRunningInstance('conv-clean')).toBeUndefined();
    });
  });

  describe('cancelReadyCheck', () => {
    it('should not throw when cancelReadyCheck is called without a token', () => {
      const state = new ConversationState();
      expect(() => state.cancelReadyCheck('nonexistent')).not.toThrow();
    });
  });

  describe('startReadyCheck edge cases', () => {
    it('should not start ready check without running instance', () => {
      const state = new ConversationState();
      state.create('conv-no-instance');
      state.startReadyCheck('conv-no-instance');
    });

    it('should not start ready check when instance has no client', () => {
      const state = new ConversationState();
      state.create('conv-no-client');
      state.setRunningInstance('conv-no-client', { process: {} as any, client: undefined as any });
      state.startReadyCheck('conv-no-client');
    });
  });

  describe('startReadyCheck with polling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should set ready=true when getSession succeeds', async () => {
      const state = new ConversationState();
      state.create('conv-ready-ok');
      const mockClient = { getSession: vi.fn().mockResolvedValue(undefined) };
      state.setRunningInstance('conv-ready-ok', { process: {} as any, client: mockClient as any });
      state.setInstanceInfo('conv-ready-ok', { sessionId: 'ses_ok' });
      state.startReadyCheck('conv-ready-ok');

      await vi.advanceTimersByTimeAsync(500);

      expect(mockClient.getSession).toHaveBeenCalledWith('ses_ok');
      expect(state.get('conv-ready-ok')?.ready).toBe(true);
    });

    it('should retry keepalive when getSession fails then succeeds', async () => {
      const state = new ConversationState();
      state.create('conv-retry-poll');
      const mockClient = {
        health: vi.fn().mockResolvedValue(undefined),
        getSession: vi.fn()
          .mockRejectedValueOnce(new Error('Not ready'))
          .mockResolvedValueOnce(undefined),
      };
      state.setRunningInstance('conv-retry-poll', { process: {} as any, client: mockClient as any });
      state.setInstanceInfo('conv-retry-poll', { sessionId: 'ses_retry' });
      state.startReadyCheck('conv-retry-poll');

      // ready is set immediately after health check
      expect(state.get('conv-retry-poll')?.ready).toBe(true);

      // First keepalive poll at 500ms: getSession fails
      await vi.advanceTimersByTimeAsync(500);
      expect(mockClient.getSession).toHaveBeenCalledTimes(1);

      // Second keepalive poll at 5500ms (500 + 5000): getSession succeeds
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockClient.getSession).toHaveBeenCalledTimes(2);
      expect(state.get('conv-retry-poll')?.ready).toBe(true);
    });

    it('should retry keepalive when sessionId not yet set', async () => {
      const state = new ConversationState();
      state.create('conv-no-ses');
      const mockClient = { getSession: vi.fn().mockResolvedValue(undefined), health: vi.fn().mockResolvedValue(undefined) };
      state.setRunningInstance('conv-no-ses', { process: {} as any, client: mockClient as any });
      state.startReadyCheck('conv-no-ses');

      // ready is set immediately; keepalive calls health() when no sessionId
      expect(state.get('conv-no-ses')?.ready).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(mockClient.health).toHaveBeenCalledTimes(1);

      state.setInstanceInfo('conv-no-ses', { sessionId: 'ses_finally' });
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockClient.getSession).toHaveBeenCalledWith('ses_finally');
      expect(state.get('conv-no-ses')?.ready).toBe(true);
    });

    it('should keep polling keepalive on session failure and mark not ready', async () => {
      const state = new ConversationState();
      state.create('conv-timeout');
      const mockClient = { getSession: vi.fn().mockRejectedValue(new Error('Not ready')), health: vi.fn() };
      state.setRunningInstance('conv-timeout', { process: {} as any, client: mockClient as any });
      state.setInstanceInfo('conv-timeout', { sessionId: 'ses_timeout' });
      state.startReadyCheck('conv-timeout');

      await vi.advanceTimersByTimeAsync(500);

      // First keepalive poll: getSession fails -> ready=false, continues polling
      expect(state.get('conv-timeout')?.ready).toBe(false);
      expect(mockClient.getSession).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      // Second keepalive poll: getSession fails again, ready stays false
      expect(mockClient.getSession).toHaveBeenCalledTimes(2);
      expect(state.get('conv-timeout')?.ready).toBe(false);
    });

    it('should keepalive after becoming ready', async () => {
      const state = new ConversationState();
      state.create('conv-keep');
      const mockClient = { getSession: vi.fn().mockResolvedValue(undefined) };
      state.setRunningInstance('conv-keep', { process: {} as any, client: mockClient as any });
      state.setInstanceInfo('conv-keep', { sessionId: 'ses_keep' });
      state.startReadyCheck('conv-keep');

      await vi.advanceTimersByTimeAsync(500);
      expect(state.get('conv-keep')?.ready).toBe(true);
      expect(mockClient.getSession).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      expect(mockClient.getSession).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(5000);
      expect(mockClient.getSession).toHaveBeenCalledTimes(3);
    });

    it('should set ready=false on keepalive failure', async () => {
      const state = new ConversationState();
      state.create('conv-lost');
      const mockClient = {
        getSession: vi.fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(new Error('Crashed')),
      };
      state.setRunningInstance('conv-lost', { process: {} as any, client: mockClient as any });
      state.setInstanceInfo('conv-lost', { sessionId: 'ses_lost' });
      state.startReadyCheck('conv-lost');

      await vi.advanceTimersByTimeAsync(500);
      expect(state.get('conv-lost')?.ready).toBe(true);

      await vi.advanceTimersByTimeAsync(5000);
      expect(state.get('conv-lost')?.ready).toBe(false);
      const events = state.get('conv-lost')!.events;
      expect(events.some((e: any) => e.type === 'conversation.readyLost')).toBe(true);
    });

    it('should cancel ready check before poll fires', async () => {
      const state = new ConversationState();
      state.create('conv-cancel-early');
      const mockClient = { getSession: vi.fn().mockRejectedValue(new Error('Not ready')) };
      state.setRunningInstance('conv-cancel-early', { process: {} as any, client: mockClient as any });
      state.setInstanceInfo('conv-cancel-early', { sessionId: 'ses_cancel' });

      state.startReadyCheck('conv-cancel-early');
      state.cancelReadyCheck('conv-cancel-early');

      await vi.advanceTimersByTimeAsync(10000);
      expect(mockClient.getSession).toHaveBeenCalledTimes(0);
    });
  });
});
