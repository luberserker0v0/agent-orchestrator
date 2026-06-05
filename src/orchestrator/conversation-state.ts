import type { ChildProcess } from 'node:child_process';
import type { OpenCodeClient } from '../opencode-http/client.js';

export type ConversationStatus =
  | 'prepared'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'stopped'
  | 'destroyed'
  | 'error';

export interface ConversationEvent {
  type: string;
  id: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface ConversationStateData {
  id: string;
  status: ConversationStatus;
  needsRestart: boolean;
  port?: number;
  sessionId?: string;
  wsUrl?: string;
  lastError?: string;
  events: ConversationEvent[];
  createdAt: number;
  updatedAt: number;
}

export interface RunningInstanceInfo {
  process: ChildProcess;
  client: OpenCodeClient;
}

const MAX_EVENTS = 100;

export class ConversationState {
  private states = new Map<string, ConversationStateData>();
  private instances = new Map<string, RunningInstanceInfo>();
  private listeners = new Map<string, Set<(event: ConversationEvent) => void>>();

  create(id: string, wsUrl?: string): ConversationStateData {
    const state: ConversationStateData = {
      id,
      status: 'prepared',
      needsRestart: false,
      wsUrl,
      events: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.states.set(id, state);
    this.emitEvent(id, 'conversation.prepared', { status: 'prepared' });
    return state;
  }

  get(id: string): ConversationStateData | undefined {
    return this.states.get(id);
  }

  has(id: string): boolean {
    return this.states.has(id);
  }

  list(): ConversationStateData[] {
    return Array.from(this.states.values());
  }

  remove(id: string): void {
    this.states.delete(id);
    this.instances.delete(id);
    this.listeners.delete(id);
  }

  transition(id: string, status: ConversationStatus, payload?: Record<string, unknown>): void {
    const state = this.states.get(id);
    if (!state) return;

    const validTransitions: Record<ConversationStatus, ConversationStatus[]> = {
      prepared: ['starting', 'destroyed'],
      starting: ['running', 'error', 'stopped'],
      running: ['restarting', 'stopped', 'error', 'destroyed'],
      restarting: ['running', 'error', 'stopped'],
      stopped: ['starting', 'destroyed'],
      destroyed: [],
      error: ['starting', 'destroyed'],
    };

    if (!validTransitions[state.status]?.includes(status)) {
      // Allow staying in same status or moving to error from any state
      if (status !== state.status && status !== 'error') {
        return;
      }
    }

    state.status = status;
    state.updatedAt = Date.now();

    if (status === 'error' && payload?.error) {
      state.lastError = String(payload.error);
    }

    this.emitEvent(id, `conversation.${status}`, { ...payload, status });
  }

  markNeedsRestart(id: string, reason: string): void {
    const state = this.states.get(id);
    if (!state) return;
    state.needsRestart = true;
    state.updatedAt = Date.now();
    this.emitEvent(id, 'conversation.needsRestart', { reason });
  }

  clearNeedsRestart(id: string): void {
    const state = this.states.get(id);
    if (!state) return;
    state.needsRestart = false;
    state.updatedAt = Date.now();
  }

  setInstanceInfo(id: string, info: { port?: number; sessionId?: string; wsUrl?: string }): void {
    const state = this.states.get(id);
    if (!state) return;
    if (info.port !== undefined) state.port = info.port;
    if (info.sessionId !== undefined) state.sessionId = info.sessionId;
    if (info.wsUrl !== undefined) state.wsUrl = info.wsUrl;
    state.updatedAt = Date.now();
  }

  setRunningInstance(id: string, info: RunningInstanceInfo): void {
    this.instances.set(id, info);
  }

  getRunningInstance(id: string): RunningInstanceInfo | undefined {
    return this.instances.get(id);
  }

  removeRunningInstance(id: string): void {
    this.instances.delete(id);
  }

  getRecentEvents(id: string, limit = 50): ConversationEvent[] {
    const state = this.states.get(id);
    if (!state) return [];
    return state.events.slice(-limit);
  }

  subscribe(id: string, callback: (event: ConversationEvent) => void): () => void {
    if (!this.listeners.has(id)) {
      this.listeners.set(id, new Set());
    }
    this.listeners.get(id)!.add(callback);
    return () => {
      this.listeners.get(id)?.delete(callback);
    };
  }

  emitEvent(id: string, type: string, payload: Record<string, unknown>): void {
    const state = this.states.get(id);
    if (!state) return;

    const event: ConversationEvent = {
      type,
      id,
      timestamp: Date.now(),
      payload,
    };

    state.events.push(event);
    if (state.events.length > MAX_EVENTS) {
      state.events.shift();
    }

    const callbacks = this.listeners.get(id);
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(event);
        } catch {
          // ignore listener errors
        }
      }
    }
  }
}
