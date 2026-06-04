import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WSConnection } from './connection.js';

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
  let handler: ReturnType<typeof vi.fn>;
  let connection: WSConnection;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockWs = createMockWebSocket();
    handler = vi.fn();
    connection = new WSConnection(mockWs as any, 'conv-001', handler, 5000, 10000);
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

  it('heartbeat terminates on timeout', () => {
    vi.advanceTimersByTime(5000);
    expect(mockWs.ping).toHaveBeenCalledTimes(1);
    expect(mockWs.isAlive).toBe(false);

    vi.advanceTimersByTime(5000);
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
});
