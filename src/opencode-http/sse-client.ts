import { logger } from '../utils/logger.js';
import { sseConnectionsActive, sseReconnectTotal } from '../metrics/registry.js';
import type { SSEClientOptions, SSEEvent } from './sse-types.js';

const DEFAULT_RECONNECT_MAX_ATTEMPTS = 10;
const DEFAULT_RECONNECT_BASE_MS = 1000;
const MAX_RECONNECT_MS = 30000;

export class OpenCodeSSEClient {
  private baseUrl: string;
  private authHeader?: string;
  private reconnectMaxAttempts: number;
  private reconnectBaseMs: number;
  private lastEventId?: string;
  private abortController?: AbortController;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private isConnecting = false;
  private isDisconnected = false;

  constructor(options: SSEClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.reconnectMaxAttempts = options.reconnectMaxAttempts ?? DEFAULT_RECONNECT_MAX_ATTEMPTS;
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;

    if (options.username && options.password) {
      this.authHeader = 'Basic ' + Buffer.from(`${options.username}:${options.password}`).toString('base64');
    }
  }

  async subscribe(onEvent: (event: SSEEvent) => void): Promise<void> {
    if (this.isDisconnected) return;
    this.isConnecting = true;
    this.abortController = new AbortController();

    try {
      const headers: Record<string, string> = {
        'Accept': 'text/event-stream',
        'Cache': 'no-cache',
      };
      if (this.authHeader) {
        headers['Authorization'] = this.authHeader;
      }
      if (this.lastEventId) {
        headers['Last-Event-ID'] = this.lastEventId;
      }

      const res = await fetch(`${this.baseUrl}/global/event`, {
        headers,
        signal: this.abortController.signal,
      });

      if (!res.ok) {
        throw new Error(`SSE connection failed: ${res.status} ${res.statusText}`);
      }

      this.reconnectAttempts = 0;
      sseConnectionsActive.inc();

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // Stream ended normally, reconnect for long-lived connection
          sseConnectionsActive.dec();
          if (!this.isDisconnected) {
            logger.debug('SSE stream ended, reconnecting...');
            this.scheduleReconnect(onEvent);
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const events = this.parseSSEBuffer(buffer);
        buffer = events.remaining;

        for (const event of events.parsed) {
          if (event.id) {
            this.lastEventId = event.id;
          }
          onEvent(event);
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        logger.debug('SSE connection aborted');
      } else {
        sseConnectionsActive.dec();
        if (!this.isDisconnected) {
          logger.error(`SSE connection error: ${(err as Error).message}`);
          this.scheduleReconnect(onEvent);
        }
      }
    } finally {
      this.isConnecting = false;
    }
  }

  private parseSSEBuffer(buffer: string): { parsed: SSEEvent[]; remaining: string } {
    const lines = buffer.split('\n');
    const remaining = lines.pop() || '';
    const parsed: SSEEvent[] = [];
    let currentEvent: Partial<SSEEvent> = {};
    let hasParseError = false;

    for (const line of lines) {
      if (line.startsWith('id:')) {
        currentEvent.id = line.slice(3).trim();
      } else if (line.startsWith('event:')) {
        currentEvent.type = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        try {
          const data = JSON.parse(line.slice(5).trim());
          currentEvent.properties = data;
        } catch {
          hasParseError = true;
        }
      } else if (line === '' && currentEvent.type) {
        // Only emit event if no parse errors occurred
        if (!hasParseError) {
          parsed.push(currentEvent as SSEEvent);
        }
        currentEvent = {};
        hasParseError = false;
      }
    }

    return { parsed, remaining };
  }

  private scheduleReconnect(onEvent: (event: SSEEvent) => void): void {
    if (this.isDisconnected) return;
    if (this.reconnectAttempts >= this.reconnectMaxAttempts) {
      sseReconnectTotal.labels('exhausted').inc();
      logger.warn(`SSE reconnection failed after ${this.reconnectMaxAttempts} attempts`);
      return;
    }

    const delay = Math.min(
      this.reconnectBaseMs * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_MS
    );
    this.reconnectAttempts++;
    sseReconnectTotal.labels('attempt').inc();

    logger.info(`SSE reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.reconnectMaxAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.subscribe(onEvent);
    }, delay);
  }

  disconnect(): void {
    this.isDisconnected = true;
    this.abortController?.abort();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    sseConnectionsActive.set(0);
  }

  getLastEventId(): string | undefined {
    return this.lastEventId;
  }
}
