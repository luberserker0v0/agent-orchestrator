import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WSConnection, type MessageHandler } from './connection.js';

function createMockWebSocket() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  return {
    readyState: 1,
    OPEN: 1,
    CONNECTING: 0,
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
    ping: vi.fn(),
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    },
    emit: (event: string, ...args: unknown[]) => {
      const cbs = listeners[event] ?? [];
      cbs.forEach((cb) => cb(...args));
    },
  };
}

describe('WSConnection', () => {
  let mockWs: ReturnType<typeof createMockWebSocket>;
  let handler: ReturnType<typeof vi.fn> & MessageHandler;
  let connection: WSConnection;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockWs = createMockWebSocket();
    handler = vi.fn() as unknown as ReturnType<typeof vi.fn> & MessageHandler;
    connection = new WSConnection(mockWs as any, 'conv-001', handler as MessageHandler, 5000, 10000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('dispatches JSON-RPC request and sends result', async () => {
    handler.mockResolvedValue({ text: 'Hello' });

    mockWs.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message.send', params: { text: 'Hi' } })));

    await vi.advanceTimersByTimeAsync(10);

    expect(handler).toHaveBeenCalledWith('message.send', { text: 'Hi' });
    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { text: 'Hello' } })
    );
  });

  it('does not send response for notification (no id)', async () => {
    handler.mockResolvedValue({});

    mockWs.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'ping' })));

    await vi.advanceTimersByTimeAsync(10);

    expect(handler).toHaveBeenCalled();
    const calls = mockWs.send.mock.calls as string[][];
    const hasId = calls.some((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return 'id' in parsed && parsed.id !== undefined;
      } catch {
        return false;
      }
    });
    expect(hasId).toBe(false);
  });

  it('sends parse error (-32700) on invalid JSON', async () => {
    mockWs.emit('message', Buffer.from('not json'));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    );
  });

  it('sends invalid request (-32600) on missing method', async () => {
    mockWs.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2 })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32600, message: 'Invalid Request' } })
    );
  });

  it('sends error (-32000) when handler throws', async () => {
    handler.mockRejectedValue(new Error('Something broke'));

    mockWs.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'fail' })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({ jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'Something broke' } })
    );
  });

  it('send() only sends when socket is OPEN', () => {
    mockWs.readyState = 0;
    connection.send({ jsonrpc: '2.0', id: 1, result: 'test' });
    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('sendEvent() dispatches event without id', () => {
    connection.sendEvent('typing', { active: true });
    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({ jsonrpc: '2.0', method: 'typing', params: { active: true } })
    );
  });

  it('closes websocket and disposes timers', () => {
    connection.close(1000, 'Done');
    expect(mockWs.close).toHaveBeenCalledWith(1000, 'Done');
  });

  it('heartbeat terminates only after consecutive misses exceed threshold', () => {
    vi.advanceTimersByTime(5000);
    expect(mockWs.ping).toHaveBeenCalledTimes(1);
    expect((connection as any).isAlive).toBe(false);

    // First two misses only warn, no terminate
    vi.advanceTimersByTime(10000);  // t=15s, 2 consecutive misses
    expect(mockWs.terminate).not.toHaveBeenCalled();

    // Third consecutive miss triggers terminate
    vi.advanceTimersByTime(5000);   // t=20s, 3 consecutive misses > threshold
    expect(mockWs.terminate).toHaveBeenCalled();
  });

  it('pong resets heartbeat and idle timer', () => {
    mockWs.emit('pong');
    expect((connection as any).isAlive).toBe(true);
  });

  it('idle timeout closes connection', () => {
    vi.advanceTimersByTime(10000);
    expect(mockWs.close).toHaveBeenCalledWith(1000, 'Idle timeout');
  });

  it('sends error for non-Error handler throw', async () => {
    handler.mockRejectedValue('string error message');

    mockWs.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'fail' })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({ jsonrpc: '2.0', id: 5, error: { code: -32000, message: 'string error message' } })
    );
  });

  it('does not send error response for notification that throws', async () => {
    handler.mockRejectedValue(new Error('no id for you'));

    mockWs.emit('message', Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'fail' })));

    await vi.advanceTimersByTimeAsync(10);

    const calls = mockWs.send.mock.calls as string[][];
    const hasError = calls.some((c) => {
      try { const p = JSON.parse(c[0]); return p.error !== undefined; } catch { return false; }
    });
    expect(hasError).toBe(false);
  });

  it('sendEvent() does nothing when socket is not OPEN', () => {
    mockWs.readyState = 2;
    connection.sendEvent('typing', { active: true });
    expect(mockWs.send).not.toHaveBeenCalled();
  });

  it('close() works with CONNECTING state', () => {
    mockWs.readyState = 0;
    connection.close(1001, 'Going away');
    expect(mockWs.close).toHaveBeenCalledWith(1001, 'Going away');
  });

  it('close() twice does not throw', () => {
    connection.close();
    expect(() => connection.close()).not.toThrow();
  });

  it('does not close socket when already CLOSED', () => {
    mockWs.readyState = 3;
    connection.close(1000, 'Already closed');
    expect(mockWs.close).not.toHaveBeenCalled();
  });
});
