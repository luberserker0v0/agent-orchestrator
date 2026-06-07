import { describe, it, expect, vi } from 'vitest';
import { ConversationState } from './conversation-state.js';

describe('ConversationState', () => {
  it('should create a prepared conversation', () => {
    const state = new ConversationState();
    const data = state.create('conv-001', 'ws://localhost:8080/ws/conv-001');

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

    // Now running -> prepared is invalid
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
    const mockClient = { getSession: vi.fn() };
    state.setRunningInstance('conv-011', { process: {} as any, client: mockClient as any });
    state.setInstanceInfo('conv-011', { sessionId: 'ses_1' });
    state.startReadyCheck('conv-011');
    expect(state.get('conv-011')?.ready).toBe(false);
    state.remove('conv-011');
    expect(state.get('conv-011')).toBeUndefined();
  });
});
