import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WSRouter } from './router.js';

// Mocks for modules used by WSRouter or its dependencies
vi.mock('cross-spawn', () => ({
  spawn: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../metrics/registry.js', () => ({
  wsConnectionsActive: {
    inc: vi.fn(),
    dec: vi.fn(),
  },
}));

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

function createMockWSS() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};

  return {
    on: (event: string, cb: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    },
    emit: (event: string, ...args: unknown[]) => {
      const cbs = listeners[event] ?? [];
      cbs.forEach((cb) => cb(...args));
    },
    close: vi.fn(),
  };
}

describe('WSRouter', () => {
  let mockWss: ReturnType<typeof createMockWSS>;
  let mockInstanceManager: any;
  let mockWorkspaceFactory: any;
  let mockConversationState: any;
  let router: WSRouter;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();

    mockWss = createMockWSS();
    mockInstanceManager = {
      getInstance: vi.fn(),
      createInstance: vi.fn(),
    };

    mockWorkspaceFactory = {
      writeConfig: vi.fn(),
      readConfig: vi.fn(),
      writeAgent: vi.fn(),
      readAgent: vi.fn(),
      deleteAgent: vi.fn(),
      listAgents: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn(),
      listFiles: vi.fn(),
      deleteFile: vi.fn(),
      copyFromLocal: vi.fn(),
    };

    mockConversationState = {
      has: vi.fn().mockReturnValue(true),
      get: vi.fn().mockReturnValue({ status: 'running' }),
      markNeedsRestart: vi.fn(),
      emitEvent: vi.fn(),
      subscribe: vi.fn().mockReturnValue(() => {}),
    };

    router = new WSRouter(
      mockWss as any,
      mockInstanceManager,
      mockWorkspaceFactory,
      mockConversationState,
      { heartbeatIntervalMs: 5000, idleTimeoutMs: 10000 },
      { port: 8080, host: '127.0.0.1', shutdownTimeoutMs: 15000 }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clean up any lingering timers from WSConnection instances
    router.closeAll();
  });

  function createMockReq(url: string) {
    return { url } as any;
  }

  function createMockInstance(overrides?: Partial<any>) {
    return {
      id: 'conv-001',
      port: 30000,
      sessionId: 'ses_1',
      defaultModel: 'anthropic/claude',
      defaultAgent: 'build',
      client: {
        sendPrompt: vi.fn().mockResolvedValue({
          info: { id: 'msg_1' },
          parts: [{ type: 'text', text: 'Hello' }],
        }),
        listMessages: vi.fn().mockResolvedValue([{ id: 'msg_1', text: 'Hello' }]),
        abortSession: vi.fn().mockResolvedValue(true),
      },
      ...overrides,
    };
  }

  it('rejects invalid path', () => {
    const mockWs = createMockWebSocket();
    mockWss.emit('connection', mockWs, createMockReq('/bad-path'));

    expect(mockWs.close).toHaveBeenCalledWith(1008, 'Invalid path');
  });

  it('rejects connection when conversation not found', async () => {
    const mockWs = createMockWebSocket();
    mockConversationState.has.mockReturnValue(false);

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    expect(mockWs.close).toHaveBeenCalledWith(1011, 'Conversation not found');
  });

  it('uses existing instance without creating new one', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    expect(mockInstanceManager.createInstance).not.toHaveBeenCalled();
    expect(mockWs.close).not.toHaveBeenCalled();
  });

  it('replaces existing connection', async () => {
    const mockWs1 = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    // First connection
    mockWss.emit('connection', mockWs1, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    expect(mockWs1.close).not.toHaveBeenCalled();

    // Second connection for same conversation
    const mockWs2 = createMockWebSocket();
    mockWss.emit('connection', mockWs2, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    expect(mockWs1.close).toHaveBeenCalledWith(1000, 'Replaced by new connection');
    // Check that the first connection received the replacement event
    const sendCalls1 = mockWs1.send.mock.calls as string[][];
    const hasReplacedEvent = sendCalls1.some((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.method === 'connection.replaced';
      } catch {
        return false;
      }
    });
    expect(hasReplacedEvent).toBe(true);
    expect(mockWs2.close).not.toHaveBeenCalled();
  });

  it('handles message.send', async () => {
    const mockWs = createMockWebSocket();
    const instance = createMockInstance();
    mockInstanceManager.getInstance.mockReturnValue(instance);

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message.send',
          params: { text: 'Hello', model: 'google/gemini', agent: 'dev' },
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(instance.client.sendPrompt).toHaveBeenCalledWith('ses_1', {
      model: { providerID: 'google', modelID: 'gemini' },
      agent: 'dev',
      parts: [{ type: 'text', text: 'Hello' }],
    });

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 1 && parsed.result;
      } catch {
        return false;
      }
    });
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0]);
    expect(parsed.result.text).toBe('Hello');
  });

  it('handles message.send with instance defaults', async () => {
    const mockWs = createMockWebSocket();
    const instance = createMockInstance();
    mockInstanceManager.getInstance.mockReturnValue(instance);

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message.send',
          params: { text: 'Hello' },
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(instance.client.sendPrompt).toHaveBeenCalledWith('ses_1', {
      model: { providerID: 'anthropic', modelID: 'claude' },
      agent: 'build',
      parts: [{ type: 'text', text: 'Hello' }],
    });
  });

  it('handles message.history', async () => {
    const mockWs = createMockWebSocket();
    const instance = createMockInstance();
    mockInstanceManager.getInstance.mockReturnValue(instance);

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'message.history',
          params: { limit: 10 },
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(instance.client.listMessages).toHaveBeenCalledWith('ses_1', 10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 2 && parsed.result;
      } catch {
        return false;
      }
    });
    expect(resultCall).toBeDefined();
  });

  it('handles session.abort', async () => {
    const mockWs = createMockWebSocket();
    const instance = createMockInstance();
    mockInstanceManager.getInstance.mockReturnValue(instance);

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'session.abort',
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(instance.client.abortSession).toHaveBeenCalledWith('ses_1');

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 3 && parsed.result?.aborted === true;
      } catch {
        return false;
      }
    });
    expect(resultCall).toBeDefined();
  });

  it('throws on unknown method', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'bad.method',
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 4 && parsed.error;
      } catch {
        return false;
      }
    });
    expect(errorCall).toBeDefined();
    const parsed = JSON.parse(errorCall![0]);
    expect(parsed.error.code).toBe(-32000);
    expect(parsed.error.message).toContain('Unknown method');
  });

  it('throws when text is missing in message.send', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'message.send',
          params: {},
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 5 && parsed.error;
      } catch {
        return false;
      }
    });
    expect(errorCall).toBeDefined();
    const parsed = JSON.parse(errorCall![0]);
    expect(parsed.error.message).toContain('Missing text');
  });

  it('throws when instance is gone during handleMessage', async () => {
    const mockWs = createMockWebSocket();
    // Return undefined when handling the message (instance not available)
    mockInstanceManager.getInstance.mockReturnValue(undefined);

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 6,
          method: 'message.send',
          params: { text: 'Hi' },
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 6 && parsed.error;
      } catch {
        return false;
      }
    });
    expect(errorCall).toBeDefined();
    const parsed = JSON.parse(errorCall![0]);
    expect(parsed.error.message).toContain('Instance not available');
  });

  it('rejects connection when conversation not found', async () => {
    const mockWs = createMockWebSocket();
    mockConversationState.has.mockReturnValue(false);

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    expect(mockWs.close).toHaveBeenCalledWith(1011, 'Conversation not found');
  });

  it('rejects connection when conversation not found', async () => {
    const mockWs = createMockWebSocket();
    mockConversationState.has.mockReturnValue(false);

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    expect(mockWs.close).toHaveBeenCalledWith(1011, 'Conversation not found');
  });

  it('closeAll closes all connections and WSS', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    router.closeAll();

    expect(mockWs.close).toHaveBeenCalledWith(1001, 'Server shutting down');
    expect(mockWss.close).toHaveBeenCalled();
  });
});
