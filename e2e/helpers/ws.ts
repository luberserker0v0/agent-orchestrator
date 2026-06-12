import WebSocket from 'ws';

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JSONRPCEvent {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

export interface WSClient {
  request(method: string, params?: Record<string, unknown>): Promise<JSONRPCResponse>;
  onEvent(cb: (event: JSONRPCEvent) => void): void;
  close(): void;
}

export function createWSClient(url: string): Promise<WSClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: JSONRPCResponse) => void; reject: (err: Error) => void }>();
    const eventHandlers: Array<(event: JSONRPCEvent) => void> = [];

    ws.on('open', () => {
      resolve({
        request(method, params) {
          return new Promise((resolvePromise, rejectPromise) => {
            const id = nextId++;
            pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
            const msg: JSONRPCRequest = { jsonrpc: '2.0', id, method, params };
            ws.send(JSON.stringify(msg));
          });
        },
        onEvent(cb) {
          eventHandlers.push(cb);
        },
        close() {
          ws.close();
        },
      });
    });

    ws.on('message', (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch { return; }

      if (msg.id !== undefined && msg.id !== null) {
        const id = msg.id as number;
        const pendingReq = pending.get(id);
        if (pendingReq) {
          pending.delete(id);
          if (msg.error) {
            const err = msg.error as { code: number; message: string };
            pendingReq.reject(new Error(err.message));
          } else {
            pendingReq.resolve(msg as unknown as JSONRPCResponse);
          }
        }
      } else if (msg.method && eventHandlers.length > 0) {
        for (const handler of eventHandlers) handler(msg as unknown as JSONRPCEvent);
      }
    });

    ws.on('error', (err) => {
      reject(err);
    });

    ws.on('close', () => {
      for (const [, pendingReq] of pending) {
        pendingReq.reject(new Error('WebSocket closed'));
      }
      pending.clear();
    });
  });
}
