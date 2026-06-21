import type { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { isAppError } from '../utils/errors.js';

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JSONRPCEvent {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type MessageHandler = (method: string, params: unknown) => Promise<unknown>;

const MAX_MISSED_HEARTBEATS = 2;

export class WSConnection {
  private ws: WebSocket;
  private handler: MessageHandler;
  private heartbeatIntervalMs: number;
  private idleTimeoutMs: number;
  private heartbeatTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private isAlive = true;
  private missedHeartbeats = 0;
  public conversationId: string;

  constructor(
    ws: WebSocket,
    conversationId: string,
    handler: MessageHandler,
    heartbeatIntervalMs: number,
    idleTimeoutMs: number
  ) {
    this.ws = ws;
    this.conversationId = conversationId;
    this.handler = handler;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.idleTimeoutMs = idleTimeoutMs;

    this.ws.on('message', (raw) => this.onMessage(raw));
    this.ws.on('pong', () => {
      this.isAlive = true;
      this.missedHeartbeats = 0;
      this.resetIdleTimer();
    });
    this.ws.on('close', () => this.dispose());
    this.ws.on('error', (err) => logger.error(`WS error [${conversationId}]:`, err));

    this.startHeartbeat();
    this.resetIdleTimer();
  }

  private async onMessage(raw: Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    this.isAlive = true;
    this.missedHeartbeats = 0;
    this.resetIdleTimer();

    let req: JSONRPCRequest;
    try {
      req = JSON.parse(raw.toString()) as JSONRPCRequest;
    } catch {
      this.sendError(null, -32700, 'Parse error');
      return;
    }

    if (req.jsonrpc !== '2.0' || !req.method) {
      this.sendError(req.id, -32600, 'Invalid Request');
      return;
    }

    logger.info(`[WS ${this.conversationId}] method: ${req.method}`);

    try {
      const result = await this.handler(req.method, req.params ?? {});
      if (req.id !== undefined && req.id !== null) {
        this.send({ jsonrpc: '2.0', id: req.id, result });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[WS ${this.conversationId}] method ${req.method} failed:`, message);
      if (req.id !== undefined && req.id !== null) {
        const data = isAppError(err) ? { code: err.code } : undefined;
        this.sendError(req.id, -32000, message, data);
      }
    }
  }

  send(data: JSONRPCResponse): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  sendEvent(method: string, params: unknown): void {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    }
  }

  private sendError(id: number | string | null | undefined, code: number, message: string, data?: { code: string }): void {
    const error: { code: number; message: string; data?: { code: string } } = { code, message };
    if (data) error.data = data;
    this.send({ jsonrpc: '2.0', id: id ?? null, error });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (!this.isAlive) {
        this.missedHeartbeats++;
        if (this.missedHeartbeats > MAX_MISSED_HEARTBEATS) {
          logger.warn(`[WS ${this.conversationId}] heartbeat timeout after ${this.missedHeartbeats} consecutive misses, closing`);
          this.ws.terminate();
        }
        return;
      }
      this.missedHeartbeats = 0;
      this.isAlive = false;
      try { this.ws.ping(); } catch { /* socket may be closing */ }
    }, this.heartbeatIntervalMs);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      logger.warn(`[WS ${this.conversationId}] idle timeout, closing`);
      this.ws.close(1000, 'Idle timeout');
    }, this.idleTimeoutMs);
  }

  close(code?: number, reason?: string): void {
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) {
      this.ws.close(code ?? 1000, reason ?? 'Connection closed');
    }
    this.dispose();
  }

  dispose(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }
}
