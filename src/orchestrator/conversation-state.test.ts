import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConversationState } from './conversation-state.js';

describe('ConversationState', () => {
  it('should create a prepared conversation', () => {
    const state = new ConversationState();
    const data = state.create('conv-001', 'opencode-direct');

    expect(data.id).toBe('conv-001');
    expect(data.status).toBe('prepared');
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

  describe('onDestroyed transition: * → stopped', () => {
    it('running → stopped is valid', () => {
      const state = new ConversationState();
      state.create('conv-on-destroyed');
      state.transition('conv-on-destroyed', 'starting');
      state.transition('conv-on-destroyed', 'running');
      state.transition('conv-on-destroyed', 'stopped');
      expect(state.get('conv-on-destroyed')?.status).toBe('stopped');
    });

    it('starting → stopped is valid', () => {
      const state = new ConversationState();
      state.create('conv-starting-stop');
      state.transition('conv-starting-stop', 'starting');
      state.transition('conv-starting-stop', 'stopped');
      expect(state.get('conv-starting-stop')?.status).toBe('stopped');
    });

    it('restarting → stopped is valid', () => {
      const state = new ConversationState();
      state.create('conv-restarting-stop');
      state.transition('conv-restarting-stop', 'starting');
      state.transition('conv-restarting-stop', 'running');
      state.transition('conv-restarting-stop', 'restarting');
      state.transition('conv-restarting-stop', 'stopped');
      expect(state.get('conv-restarting-stop')?.status).toBe('stopped');
    });

    it('error → stopped is silently ignored (not a valid transition)', () => {
      const state = new ConversationState();
      state.create('conv-error-stop');
      state.transition('conv-error-stop', 'error');
      state.transition('conv-error-stop', 'stopped');
      expect(state.get('conv-error-stop')?.status).toBe('error');
    });

    it('prepared → stopped is silently ignored', () => {
      const state = new ConversationState();
      state.create('conv-prepared-stop');
      state.transition('conv-prepared-stop', 'stopped');
      expect(state.get('conv-prepared-stop')?.status).toBe('prepared');
    });

    it('destroyed → stopped is silently ignored', () => {
      const state = new ConversationState();
      state.create('conv-destroyed-stop');
      state.transition('conv-destroyed-stop', 'starting');
      state.transition('conv-destroyed-stop', 'running');
      state.transition('conv-destroyed-stop', 'destroyed');
      state.transition('conv-destroyed-stop', 'stopped');
      expect(state.get('conv-destroyed-stop')?.status).toBe('destroyed');
    });

    it('stopped → stopped (same status) is allowed', () => {
      const state = new ConversationState();
      state.create('conv-stopped-stop');
      state.transition('conv-stopped-stop', 'starting');
      state.transition('conv-stopped-stop', 'running');
      state.transition('conv-stopped-stop', 'stopped');
      state.transition('conv-stopped-stop', 'stopped');
      expect(state.get('conv-stopped-stop')?.status).toBe('stopped');
    });
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
    const mockClient = {} as any;

    state.setRunningInstance('conv-006', { client: mockClient });
    expect(state.getRunningInstance('conv-006')?.client).toBe(mockClient);

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
    state.setRunningInstance('conv-011', { client: mockClient as any });
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

    it('should allow stopped to restarting transition', () => {
      const state = new ConversationState();
      state.create('conv-stop-restart');
      state.transition('conv-stop-restart', 'starting');
      state.transition('conv-stop-restart', 'stopped');
      state.transition('conv-stop-restart', 'restarting');
      expect(state.get('conv-stop-restart')?.status).toBe('restarting');
    });

    it('should allow error to restarting transition', () => {
      const state = new ConversationState();
      state.create('conv-err-restart');
      state.transition('conv-err-restart', 'starting');
      state.transition('conv-err-restart', 'error');
      state.transition('conv-err-restart', 'restarting');
      expect(state.get('conv-err-restart')?.status).toBe('restarting');
    });

    it('should reject destroyed to starting', () => {
      const state = new ConversationState();
      state.create('conv-d2s');
      state.transition('conv-d2s', 'destroyed');
      state.transition('conv-d2s', 'starting');
      expect(state.get('conv-d2s')?.status).toBe('destroyed');
    });

    it('should reject destroyed to running', () => {
      const state = new ConversationState();
      state.create('conv-d2r');
      state.transition('conv-d2r', 'destroyed');
      state.transition('conv-d2r', 'running');
      expect(state.get('conv-d2r')?.status).toBe('destroyed');
    });

    it('should reject destroyed to stopped', () => {
      const state = new ConversationState();
      state.create('conv-d2st');
      state.transition('conv-d2st', 'destroyed');
      state.transition('conv-d2st', 'stopped');
      expect(state.get('conv-d2st')?.status).toBe('destroyed');
    });

    it('should reject destroyed to restarting', () => {
      const state = new ConversationState();
      state.create('conv-d2rs');
      state.transition('conv-d2rs', 'destroyed');
      state.transition('conv-d2rs', 'restarting');
      expect(state.get('conv-d2rs')?.status).toBe('destroyed');
    });

    it('should allow destroyed to error (last resort)', () => {
      const state = new ConversationState();
      state.create('conv-d2e');
      state.transition('conv-d2e', 'destroyed');
      state.transition('conv-d2e', 'error', { error: 'after destroyed' });
      expect(state.get('conv-d2e')?.status).toBe('error');
      expect(state.get('conv-d2e')?.lastError).toBe('after destroyed');
    });

    it('should allow prepared to destroyed transition', () => {
      const state = new ConversationState();
      state.create('conv-p2d');
      state.transition('conv-p2d', 'destroyed');
      expect(state.get('conv-p2d')?.status).toBe('destroyed');
    });

    it('should allow running to destroyed transition', () => {
      const state = new ConversationState();
      state.create('conv-run2d');
      state.transition('conv-run2d', 'starting');
      state.transition('conv-run2d', 'running');
      state.transition('conv-run2d', 'destroyed');
      expect(state.get('conv-run2d')?.status).toBe('destroyed');
    });

    it('should allow stopped to destroyed transition', () => {
      const state = new ConversationState();
      state.create('conv-st2d');
      state.transition('conv-st2d', 'starting');
      state.transition('conv-st2d', 'running');
      state.transition('conv-st2d', 'stopped');
      state.transition('conv-st2d', 'destroyed');
      expect(state.get('conv-st2d')?.status).toBe('destroyed');
    });

    it('should allow error to destroyed transition', () => {
      const state = new ConversationState();
      state.create('conv-e2d');
      state.transition('conv-e2d', 'starting');
      state.transition('conv-e2d', 'error');
      state.transition('conv-e2d', 'destroyed');
      expect(state.get('conv-e2d')?.status).toBe('destroyed');
    });

    it('should allow error to starting transition (restart from error)', () => {
      const state = new ConversationState();
      state.create('conv-e2s');
      state.transition('conv-e2s', 'starting');
      state.transition('conv-e2s', 'error');
      state.transition('conv-e2s', 'starting');
      expect(state.get('conv-e2s')?.status).toBe('starting');
    });

    it('duplicate create overwrites existing state', () => {
      const state = new ConversationState();
      state.create('conv-dup', 'opencode-direct');
      state.transition('conv-dup', 'starting');
      state.create('conv-dup', 'docker');
      const data = state.get('conv-dup');
      expect(data?.status).toBe('prepared');
      expect(data?.agentType).toBe('docker');
    });

    it('full lifecycle rapid transitions', () => {
      const state = new ConversationState();
      state.create('conv-full');
      state.transition('conv-full', 'starting');
      state.transition('conv-full', 'running');
      state.transition('conv-full', 'restarting');
      state.transition('conv-full', 'running');
      state.transition('conv-full', 'stopped');
      state.transition('conv-full', 'starting');
      state.transition('conv-full', 'error');
      state.transition('conv-full', 'destroyed');
      expect(state.get('conv-full')?.status).toBe('destroyed');
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
      const mockClient = {} as any;
      state.setRunningInstance('conv-clean', { client: mockClient });
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
      state.setRunningInstance('conv-no-client', { client: undefined as any });
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
      state.setRunningInstance('conv-ready-ok', { client: mockClient as any });
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
      state.setRunningInstance('conv-retry-poll', { client: mockClient as any });
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
      state.setRunningInstance('conv-no-ses', { client: mockClient as any });
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
      state.setRunningInstance('conv-timeout', { client: mockClient as any });
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
      state.setRunningInstance('conv-keep', { client: mockClient as any });
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
      state.setRunningInstance('conv-lost', { client: mockClient as any });
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
      state.setRunningInstance('conv-cancel-early', { client: mockClient as any });
      state.setInstanceInfo('conv-cancel-early', { sessionId: 'ses_cancel' });

      state.startReadyCheck('conv-cancel-early');
      state.cancelReadyCheck('conv-cancel-early');

      await vi.advanceTimersByTimeAsync(10000);
      expect(mockClient.getSession).toHaveBeenCalledTimes(0);
    });

    it('should stop polling after cancelReadyCheck following poll failure', async () => {
      const state = new ConversationState();
      state.create('conv-stop-after-fail');
      const mockClient = { getSession: vi.fn().mockRejectedValue(new Error('Not ready')) };
      state.setRunningInstance('conv-stop-after-fail', { client: mockClient as any });
      state.setInstanceInfo('conv-stop-after-fail', { sessionId: 'ses_stop_fail' });

      state.startReadyCheck('conv-stop-after-fail');

      // First poll fires at 500ms, getSession fails -> ready=false
      await vi.advanceTimersByTimeAsync(500);
      expect(mockClient.getSession).toHaveBeenCalledTimes(1);
      expect(state.get('conv-stop-after-fail')?.ready).toBe(false);

      // Cancel before the next scheduled poll (at 5500ms)
      state.cancelReadyCheck('conv-stop-after-fail');

      // Advance well past the second poll time — client should not be called again
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockClient.getSession).toHaveBeenCalledTimes(1);
      expect(state.get('conv-stop-after-fail')?.ready).toBe(false);
    });

    it('should stop polling after cancelReadyCheck following poll success', async () => {
      const state = new ConversationState();
      state.create('conv-stop-after-ok');
      const mockClient = { getSession: vi.fn().mockResolvedValue(undefined) };
      state.setRunningInstance('conv-stop-after-ok', { client: mockClient as any });
      state.setInstanceInfo('conv-stop-after-ok', { sessionId: 'ses_stop_ok' });

      state.startReadyCheck('conv-stop-after-ok');

      // First poll at 500ms succeeds -> ready=true
      await vi.advanceTimersByTimeAsync(500);
      expect(mockClient.getSession).toHaveBeenCalledTimes(1);
      expect(state.get('conv-stop-after-ok')?.ready).toBe(true);

      // Cancel before next keepalive at 5500ms
      state.cancelReadyCheck('conv-stop-after-ok');

      // Advance past the keepalive time — client should not be called again, ready stays true
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockClient.getSession).toHaveBeenCalledTimes(1);
      expect(state.get('conv-stop-after-ok')?.ready).toBe(true);
    });

    it('should use fresh client when startReadyCheck called after cancelReadyCheck', async () => {
      const state = new ConversationState();
      state.create('conv-client-isolation');
      const mockClientOld = { getSession: vi.fn().mockRejectedValue(new Error('dead')) };
      const mockClientNew = { getSession: vi.fn().mockResolvedValue(undefined) };

      // Start with old (failing) client
      state.setRunningInstance('conv-client-isolation', { client: mockClientOld as any });
      state.setInstanceInfo('conv-client-isolation', { sessionId: 'ses_old' });
      state.startReadyCheck('conv-client-isolation');

      // First poll fails with old client -> ready=false
      await vi.advanceTimersByTimeAsync(500);
      expect(mockClientOld.getSession).toHaveBeenCalledTimes(1);
      expect(state.get('conv-client-isolation')?.ready).toBe(false);

      // Cancel and swap to new client
      state.cancelReadyCheck('conv-client-isolation');
      state.setRunningInstance('conv-client-isolation', { client: mockClientNew as any });
      state.setInstanceInfo('conv-client-isolation', { sessionId: 'ses_new' });
      state.startReadyCheck('conv-client-isolation');

      // New client's first poll at 500ms (from re-start)
      await vi.advanceTimersByTimeAsync(500);
      expect(mockClientNew.getSession).toHaveBeenCalledWith('ses_new');
      expect(state.get('conv-client-isolation')?.ready).toBe(true);

      // Old client should not have been called again
      expect(mockClientOld.getSession).toHaveBeenCalledTimes(1);
    });
  });
});
