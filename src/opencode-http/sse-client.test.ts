import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenCodeSSEClient } from './sse-client.js';
import type { SSEEvent } from './sse-types.js';

vi.mock('../metrics/registry.js', () => {
  const inc = vi.fn();
  const dec = vi.fn();
  const set = vi.fn();
  const gaugeLabels = vi.fn().mockReturnValue({ inc, dec });
  const counterLabels = vi.fn().mockReturnValue({ inc });
  return {
    sseConnectionsActive: { inc: gaugeLabels, dec: gaugeLabels, set },
    sseReconnectTotal: { labels: counterLabels },
  };
});

function createMockReadableStream() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  return { stream, controller: controller! };
}

function createSSEResponse(events: string[]) {
  const encoder = new TextEncoder();
  const { stream, controller } = createMockReadableStream();

  // Write events in next microtask to simulate streaming
  Promise.resolve().then(() => {
    for (const event of events) {
      controller.enqueue(encoder.encode(event));
    }
    controller.close();
  });

  return {
    ok: true,
    status: 200,
    body: stream,
  } as unknown as Response;
}

function createErrorResponse(status: number, statusText: string) {
  return {
    ok: false,
    status,
    statusText,
    text: vi.fn().mockResolvedValue('Error'),
  } as unknown as Response;
}

describe('OpenCodeSSEClient', () => {
  let client: OpenCodeSSEClient;
  let fetchFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new OpenCodeSSEClient({
      baseUrl: 'http://localhost:3000',
      reconnectMaxAttempts: 3,
      reconnectBaseMs: 100,
    });
  });

  afterEach(() => {
    client.disconnect();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('removes trailing slash from baseUrl', () => {
      const c = new OpenCodeSSEClient({ baseUrl: 'http://localhost:3000/' });
      expect((c as any).baseUrl).toBe('http://localhost:3000');
    });

    it('sets auth header when credentials provided', () => {
      const c = new OpenCodeSSEClient({
        baseUrl: 'http://localhost:3000',
        username: 'user',
        password: 'pass',
      });
      expect((c as any).authHeader).toContain('Basic ');
    });

    it('does not set auth header without credentials', () => {
      expect((client as any).authHeader).toBeUndefined();
    });

    it('uses default reconnect options', () => {
      const c = new OpenCodeSSEClient({ baseUrl: 'http://localhost:3000' });
      expect((c as any).reconnectMaxAttempts).toBe(10);
      expect((c as any).reconnectBaseMs).toBe(1000);
    });
  });

  describe('subscribe', () => {
    it('parses SSE events correctly', async () => {
      const events = [
        'event: server.connected\ndata: {"version":"1.0.0"}\n\n',
        'event: session.created\ndata: {"session":{"id":"ses_1"}}\n\n',
      ];

      fetchFn = vi.fn().mockResolvedValue(createSSEResponse(events));
      vi.stubGlobal('fetch', fetchFn);

      const receivedEvents: SSEEvent[] = [];
      const subscribePromise = client.subscribe((event) => {
        receivedEvents.push(event);
        // Stop after receiving events to prevent infinite reconnection
        if (receivedEvents.length >= 2) {
          client.disconnect();
        }
      });

      await vi.runAllTimersAsync();
      await subscribePromise;

      expect(receivedEvents).toHaveLength(2);
      expect(receivedEvents[0].type).toBe('server.connected');
      expect(receivedEvents[0].properties).toEqual({ version: '1.0.0' });
      expect(receivedEvents[1].type).toBe('session.created');
      expect(receivedEvents[1].properties).toEqual({ session: { id: 'ses_1' } });
    });

    it('parses event id for reconnection', async () => {
      const events = ['id: 123\nevent: server.connected\ndata: {"ok":true}\n\n'];

      fetchFn = vi.fn().mockResolvedValue(createSSEResponse(events));
      vi.stubGlobal('fetch', fetchFn);

      const receivedEvents: SSEEvent[] = [];
      const subscribePromise = client.subscribe((event) => {
        receivedEvents.push(event);
        client.disconnect();
      });

      await vi.runAllTimersAsync();
      await subscribePromise;

      expect(receivedEvents[0].id).toBe('123');
      expect(client.getLastEventId()).toBe('123');
    });

    it('sends auth header when configured', async () => {
      const authClient = new OpenCodeSSEClient({
        baseUrl: 'http://localhost:3000',
        username: 'user',
        password: 'pass',
      });

      fetchFn = vi.fn().mockResolvedValue(createSSEResponse([]));
      vi.stubGlobal('fetch', fetchFn);

      await authClient.subscribe(() => {});

      expect(fetchFn).toHaveBeenCalledWith(
        'http://localhost:3000/global/event',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining('Basic '),
          }),
        })
      );
    });

    it('sends Last-Event-ID header on reconnection', async () => {
      const events = ['id: 42\nevent: test\ndata: {}\n\n'];

      fetchFn = vi.fn()
        .mockResolvedValueOnce(createSSEResponse(events))
        .mockResolvedValueOnce(createSSEResponse([]));
      vi.stubGlobal('fetch', fetchFn);

      let callCount = 0;
      const subscribePromise = client.subscribe(() => {
        callCount++;
        if (callCount >= 1) {
          client.disconnect();
        }
      });
      await vi.runAllTimersAsync();
      await subscribePromise;

      // Reconnect to check headers
      const reconnectClient = new OpenCodeSSEClient({
        baseUrl: 'http://localhost:3000',
        reconnectMaxAttempts: 1,
        reconnectBaseMs: 100,
      });

      // Set the last event id manually to test
      (reconnectClient as any).lastEventId = '42';

      fetchFn = vi.fn().mockResolvedValue(createSSEResponse([]));
      vi.stubGlobal('fetch', fetchFn);

      await reconnectClient.subscribe(() => {});

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const callHeaders = fetchFn.mock.calls[0][1].headers;
      expect(callHeaders['Last-Event-ID']).toBe('42');

      reconnectClient.disconnect();
    });

    it('handles non-ok response', async () => {
      fetchFn = vi.fn().mockResolvedValue(createErrorResponse(404, 'Not Found'));
      vi.stubGlobal('fetch', fetchFn);

      const logger = await import('../utils/logger.js');
      const warnSpy = vi.spyOn(logger.logger, 'error').mockImplementation(() => {});

      await client.subscribe(() => {});

      expect(warnSpy).toHaveBeenCalled();
    });

    it('skips malformed JSON data', async () => {
      const events = [
        'event: test\ndata: {invalid json}\n\n',
        'event: test\ndata: {"valid":true}\n\n',
      ];

      fetchFn = vi.fn().mockResolvedValue(createSSEResponse(events));
      vi.stubGlobal('fetch', fetchFn);

      const receivedEvents: SSEEvent[] = [];
      const subscribePromise = client.subscribe((event) => {
        receivedEvents.push(event);
        client.disconnect();
      });

      await vi.runAllTimersAsync();
      await subscribePromise;

      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0].properties).toEqual({ valid: true });
    });

    it('handles \\r\\n line endings', async () => {
      const events = [
        'event: server.connected\r\ndata: {"version":"1.0.0"}\r\n\r\n',
        'event: session.created\r\ndata: {"session":{"id":"ses_1"}}\r\n\r\n',
      ];

      fetchFn = vi.fn().mockResolvedValue(createSSEResponse(events));
      vi.stubGlobal('fetch', fetchFn);

      const receivedEvents: SSEEvent[] = [];
      const subscribePromise = client.subscribe((event) => {
        receivedEvents.push(event);
        if (receivedEvents.length >= 2) {
          client.disconnect();
        }
      });

      await vi.runAllTimersAsync();
      await subscribePromise;

      expect(receivedEvents).toHaveLength(2);
      expect(receivedEvents[0].type).toBe('server.connected');
      expect(receivedEvents[0].properties).toEqual({ version: '1.0.0' });
      expect(receivedEvents[1].type).toBe('session.created');
    });

    it('handles mixed \\n and \\r\\n line endings', async () => {
      const events = [
        'event: test\ndata: {"a":1}\r\n\r\n',
        'event: test2\r\ndata: {"b":2}\n\n',
      ];

      fetchFn = vi.fn().mockResolvedValue(createSSEResponse(events));
      vi.stubGlobal('fetch', fetchFn);

      const receivedEvents: SSEEvent[] = [];
      const subscribePromise = client.subscribe((event) => {
        receivedEvents.push(event);
        if (receivedEvents.length >= 2) {
          client.disconnect();
        }
      });

      await vi.runAllTimersAsync();
      await subscribePromise;

      expect(receivedEvents).toHaveLength(2);
      expect(receivedEvents[0].properties).toEqual({ a: 1 });
      expect(receivedEvents[1].properties).toEqual({ b: 2 });
    });
  });

  describe('reconnection', () => {
    it('reconnects when stream ends', async () => {
      let fetchCallCount = 0;
      fetchFn = vi.fn().mockImplementation(() => {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          // First call returns empty stream that ends immediately
          return Promise.resolve(createSSEResponse([]));
        }
        // Second call - disconnect to stop reconnection loop
        client.disconnect();
        return Promise.resolve(createSSEResponse([]));
      });
      vi.stubGlobal('fetch', fetchFn);

      await client.subscribe(() => {});

      // Wait for reconnection
      await vi.advanceTimersByTimeAsync(100);
      await vi.runAllTimersAsync();

      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('reconnects on connection error', async () => {
      fetchFn = vi.fn()
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce(createSSEResponse([]));
      vi.stubGlobal('fetch', fetchFn);

      const logger = await import('../utils/logger.js');
      vi.spyOn(logger.logger, 'error').mockImplementation(() => {});

      const subscribePromise = client.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(100);
      await subscribePromise;

      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('uses exponential backoff', async () => {
      fetchFn = vi.fn().mockRejectedValue(new Error('Connection refused'));
      vi.stubGlobal('fetch', fetchFn);

      const logger = await import('../utils/logger.js');
      vi.spyOn(logger.logger, 'error').mockImplementation(() => {});
      vi.spyOn(logger.logger, 'info').mockImplementation(() => {});

      client.subscribe(() => {});

      // First attempt
      await vi.advanceTimersByTimeAsync(0);

      // Second attempt after 100ms
      await vi.advanceTimersByTimeAsync(100);

      // Third attempt after 200ms
      await vi.advanceTimersByTimeAsync(200);

      // Should have tried 3 times
      expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it('stops after max attempts', async () => {
      fetchFn = vi.fn().mockRejectedValue(new Error('Connection refused'));
      vi.stubGlobal('fetch', fetchFn);

      const logger = await import('../utils/logger.js');
      vi.spyOn(logger.logger, 'error').mockImplementation(() => {});
      vi.spyOn(logger.logger, 'warn').mockImplementation(() => {});
      vi.spyOn(logger.logger, 'info').mockImplementation(() => {});

      client.subscribe(() => {});

      // Wait for all attempts (1 initial + 3 reconnections = 4 total)
      await vi.advanceTimersByTimeAsync(2000);

      expect(fetchFn).toHaveBeenCalledTimes(4);
    });
  });

  describe('disconnect', () => {
    it('stops reconnection attempts', async () => {
      fetchFn = vi.fn().mockRejectedValue(new Error('Connection refused'));
      vi.stubGlobal('fetch', fetchFn);

      const logger = await import('../utils/logger.js');
      vi.spyOn(logger.logger, 'error').mockImplementation(() => {});

      client.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);

      client.disconnect();

      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('aborts ongoing connection', async () => {
      // Create a fetch that respects AbortSignal
      fetchFn = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
        return new Promise((resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            const err = new DOMException('The operation was aborted.', 'AbortError');
            reject(err);
          });
          // Never resolve - simulates pending connection
        });
      });
      vi.stubGlobal('fetch', fetchFn);

      const logger = await import('../utils/logger.js');
      vi.spyOn(logger.logger, 'debug').mockImplementation(() => {});

      const subscribePromise = client.subscribe(() => {});

      // Give time for fetch to be called
      await vi.advanceTimersByTimeAsync(10);

      client.disconnect();

      // Should resolve without hanging
      await subscribePromise;
    });
  });

  describe('getLastEventId', () => {
    it('returns undefined initially', () => {
      expect(client.getLastEventId()).toBeUndefined();
    });

    it('returns last event id after receiving events', async () => {
      const events = ['id: 99\nevent: test\ndata: {}\n\n'];

      fetchFn = vi.fn().mockResolvedValue(createSSEResponse(events));
      vi.stubGlobal('fetch', fetchFn);

      const subscribePromise = client.subscribe(() => {
        client.disconnect();
      });
      await vi.runAllTimersAsync();
      await subscribePromise;

      expect(client.getLastEventId()).toBe('99');
    });
  });

  describe('metrics', () => {
    it('increments sse_connections_active on successful connection', async () => {
      const { sseConnectionsActive } = await import('../metrics/registry.js');
      const events = ['event: test\ndata: {}\n\n'];
      fetchFn = vi.fn().mockResolvedValue(createSSEResponse(events));
      vi.stubGlobal('fetch', fetchFn);

      const subscribePromise = client.subscribe(() => {
        client.disconnect();
      });
      await vi.runAllTimersAsync();
      await subscribePromise;

      expect(sseConnectionsActive.inc).toHaveBeenCalled();
    });

    it('decrements sse_connections_active on disconnect', async () => {
      const { sseConnectionsActive } = await import('../metrics/registry.js');
      fetchFn = vi.fn().mockRejectedValue(new Error('Connection refused'));
      vi.stubGlobal('fetch', fetchFn);

      const logger = await import('../utils/logger.js');
      vi.spyOn(logger.logger, 'error').mockImplementation(() => {});

      client.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);

      client.disconnect();

      expect(sseConnectionsActive.set).toHaveBeenCalledWith(0);
    });

    it('increments sse_reconnect_total on reconnection attempt', async () => {
      const { sseReconnectTotal } = await import('../metrics/registry.js');
      let fetchCallCount = 0;
      fetchFn = vi.fn().mockImplementation(() => {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          return Promise.resolve(createSSEResponse([]));
        }
        client.disconnect();
        return Promise.resolve(createSSEResponse([]));
      });
      vi.stubGlobal('fetch', fetchFn);

      await client.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(100);
      await vi.runAllTimersAsync();

      expect(sseReconnectTotal.labels).toHaveBeenCalledWith('attempt');
    });

    it('increments sse_reconnect_total with exhausted label after max attempts', async () => {
      const { sseReconnectTotal } = await import('../metrics/registry.js');
      fetchFn = vi.fn().mockRejectedValue(new Error('Connection refused'));
      vi.stubGlobal('fetch', fetchFn);

      const logger = await import('../utils/logger.js');
      vi.spyOn(logger.logger, 'error').mockImplementation(() => {});
      vi.spyOn(logger.logger, 'warn').mockImplementation(() => {});
      vi.spyOn(logger.logger, 'info').mockImplementation(() => {});

      client.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(2000);

      expect(sseReconnectTotal.labels).toHaveBeenCalledWith('exhausted');
    });
  });
});
