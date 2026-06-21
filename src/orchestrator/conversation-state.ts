import { conversationStateChangesTotal } from '../metrics/registry.js';
import type { AgentClient } from '../agent-runtime/types.js';

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
  agentType: string;
  status: ConversationStatus;
  ready: boolean;
  needsRestart: boolean;
  port?: number;
  sessionId?: string;
  lastError?: string;
  events: ConversationEvent[];
  createdAt: number;
  updatedAt: number;
}

export interface RunningInstanceInfo {
  client: AgentClient;
}

const MAX_EVENTS = 100;

interface ReadyCheckToken {
  cancel: () => void;
}
const READY_CHECK_INTERVAL_MS = 500;
const READY_CHECK_KEEPALIVE_INTERVAL_MS = 5000; // After ready=true, keep alive every 5s

export class ConversationState {
  private states = new Map<string, ConversationStateData>();
  private instances = new Map<string, RunningInstanceInfo>();
  private listeners = new Map<string, Set<(event: ConversationEvent) => void>>();
  private readyTokens = new Map<string, ReadyCheckToken>();

  create(id: string, agentType = 'opencode-direct'): ConversationStateData {
    const state: ConversationStateData = {
      id,
      agentType,
      status: 'prepared',
      ready: false,
      needsRestart: false,
      events: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.states.set(id, state);
    this.emitEvent(id, 'conversation.prepared', { status: 'prepared', agentType });
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
    this.cancelReadyCheck(id);
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
      error: ['starting', 'restarting', 'destroyed'],
    };

    if (!validTransitions[state.status]?.includes(status)) {
      // Allow staying in same status or moving to error from any state
      if (status !== state.status && status !== 'error') {
        return;
      }
    }

    state.status = status;
    state.updatedAt = Date.now();
    conversationStateChangesTotal.inc({ status });

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

  cancelReadyCheck(id: string): void {
    const token = this.readyTokens.get(id);
    if (token) {
      token.cancel();
      this.readyTokens.delete(id);
    }
  }

  startReadyCheck(id: string): void {
    const info = this.instances.get(id);
    if (!info || !info.client) return;

    // Health check already passed — mark ready immediately
    const state = this.states.get(id);
    if (state) {
      state.ready = true;
      state.updatedAt = Date.now();
      this.emitEvent(id, 'conversation.ready', {});
    }

    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    const scheduleNext = (fn: () => void, ms: number) => {
      if (!stopped) timer = setTimeout(fn, ms);
    };

    const pollKeepalive = async () => {
      if (stopped) return;
      try {
        const sessionId = this.states.get(id)?.sessionId;
        if (!sessionId) {
          await info.client!.health();
        } else {
          await info.client!.getSession(sessionId);
        }
        const currentState = this.states.get(id);
        if (currentState && !currentState.ready) {
          currentState.ready = true;
          currentState.updatedAt = Date.now();
          this.emitEvent(id, 'conversation.ready', {});
        }
        scheduleNext(pollKeepalive, READY_CHECK_KEEPALIVE_INTERVAL_MS);
      } catch {
        const currentState = this.states.get(id);
        if (currentState && !stopped) {
          currentState.ready = false;
          currentState.updatedAt = Date.now();
          this.emitEvent(id, 'conversation.readyLost', {});
          scheduleNext(pollKeepalive, READY_CHECK_KEEPALIVE_INTERVAL_MS);
        }
      }
    };

    timer = setTimeout(pollKeepalive, READY_CHECK_INTERVAL_MS);

    this.readyTokens.set(id, {
      cancel: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    });
  }

  setInstanceInfo(id: string, info: { port?: number; sessionId?: string }): void {
    const state = this.states.get(id);
    if (!state) return;
    if (info.port !== undefined) state.port = info.port;
    if (info.sessionId !== undefined) state.sessionId = info.sessionId;
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
