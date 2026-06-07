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
      importSkillFromLocal: vi.fn(),
      listSkills: vi.fn(),
      readSkill: vi.fn(),
      getSkillInfo: vi.fn(),
      deleteSkill: vi.fn(),
      writeAgentsMd: vi.fn(),
      readAgentsMd: vi.fn(),
      deleteAgentsMd: vi.fn(),
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
      client: {
        sendPrompt: vi.fn().mockResolvedValue({
          info: { id: 'msg_1' },
          parts: [{ type: 'text', text: 'Hello' }],
        }),
        listMessages: vi.fn().mockResolvedValue([{ id: 'msg_1', text: 'Hello' }]),
        abortSession: vi.fn().mockResolvedValue(true),
        createSession: vi.fn().mockResolvedValue({ id: 'ses_new', title: 'custom', status: 'active', created_at: '2026-01-01', updated_at: '2026-01-01' }),
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

  it('handles message.send without model/agent params', async () => {
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
      model: undefined,
      agent: undefined,
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

  it('handles session.create', async () => {
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
          id: 25,
          method: 'session.create',
          params: { title: 'custom', parentID: 'ses_1' },
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(instance.client.createSession).toHaveBeenCalledWith({ title: 'custom', parentID: 'ses_1' });

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 25 && parsed.result?.id === 'ses_new';
      } catch {
        return false;
      }
    });
    expect(resultCall).toBeDefined();
  });

  it('rejects session.create when conversation is not running', async () => {
    const mockWs = createMockWebSocket();
    const instance = createMockInstance();
    mockConversationState.get.mockReturnValue({ status: 'prepared' });
    mockInstanceManager.getInstance.mockReturnValue(instance);

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 26,
          method: 'session.create',
          params: { title: 'custom' },
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(instance.client.createSession).not.toHaveBeenCalled();

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 26 && parsed.error?.message?.includes('not running');
      } catch {
        return false;
      }
    });
    expect(errorCall).toBeDefined();
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

  it('handles skills.list', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());
    mockWorkspaceFactory.listSkills.mockReturnValue(['web-search', 'code-review']);

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 20,
          method: 'skills.list',
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 20 && parsed.result;
      } catch {
        return false;
      }
    });
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0]);
    expect(parsed.result).toEqual(['web-search', 'code-review']);
  });

  it('handles skills.get', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());
    mockWorkspaceFactory.readSkill.mockReturnValue('# web-search\nA skill.');

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 21,
          method: 'skills.get',
          params: { name: 'web-search' },
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 21 && parsed.result;
      } catch {
        return false;
      }
    });
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0]);
    expect(parsed.result).toBe('# web-search\nA skill.');
  });

  it('handles skills.info', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());
    mockWorkspaceFactory.getSkillInfo.mockReturnValue({
      name: 'web-search',
      files: ['SKILL.md'],
      totalSize: 1234,
      sha256: 'abc123',
    });

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 22,
          method: 'skills.info',
          params: { name: 'web-search' },
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 22 && parsed.result;
      } catch {
        return false;
      }
    });
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0]);
    expect(parsed.result.sha256).toBe('abc123');
  });

  it('handles skills.delete', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 23,
          method: 'skills.delete',
          params: { name: 'web-search' },
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(mockWorkspaceFactory.deleteSkill).toHaveBeenCalledWith('conv-001', 'web-search');

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 23 && parsed.result?.deleted === 'web-search';
      } catch {
        return false;
      }
    });
    expect(resultCall).toBeDefined();
  });

  it('handles skills.import with invalid name', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 24,
          method: 'skills.import',
          params: { source: 'skills/test', name: 'foo/bar' },
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(mockWorkspaceFactory.importSkillFromLocal).not.toHaveBeenCalled();

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 24 && parsed.error?.message?.includes('Invalid skill name');
      } catch {
        return false;
      }
    });
    expect(errorCall).toBeDefined();
  });

  it('handles skills.import with source from sibling prefix path skills_evil/', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());
    mockWorkspaceFactory.importSkillFromLocal.mockImplementation(() => {
      throw new Error('Source path not allowed. Must be under one of: ...');
    });

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 25,
          method: 'skills.import',
          params: { source: 'skills_evil/web-search', name: 'web-search' },
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(mockWorkspaceFactory.importSkillFromLocal).toHaveBeenCalledWith('conv-001', 'skills_evil/web-search', 'web-search');

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 25 && parsed.error?.message?.includes('Source path not allowed');
      } catch {
        return false;
      }
    });
    expect(errorCall).toBeDefined();
  });

  it('handles skills.get with invalid name', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 25,
          method: 'skills.get',
          params: { name: 'foo/bar' },
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(mockWorkspaceFactory.readSkill).not.toHaveBeenCalled();

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 25 && parsed.error?.message?.includes('Invalid skill name');
      } catch {
        return false;
      }
    });
    expect(errorCall).toBeDefined();
  });

  it('handles skills.info with invalid name', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 26,
          method: 'skills.info',
          params: { name: 'foo/bar' },
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(mockWorkspaceFactory.getSkillInfo).not.toHaveBeenCalled();

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 26 && parsed.error?.message?.includes('Invalid skill name');
      } catch {
        return false;
      }
    });
    expect(errorCall).toBeDefined();
  });

  it('handles skills.delete with invalid name', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 27,
          method: 'skills.delete',
          params: { name: 'foo/bar' },
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(mockWorkspaceFactory.deleteSkill).not.toHaveBeenCalled();

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 27 && parsed.error?.message?.includes('Invalid skill name');
      } catch {
        return false;
      }
    });
    expect(errorCall).toBeDefined();
  });

  it('handles agent.config.write', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 30,
          method: 'agent.config.write',
          params: { content: '# Agents\nDesigner agent.' },
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(mockWorkspaceFactory.writeAgentsMd).toHaveBeenCalledWith('conv-001', '# Agents\nDesigner agent.');
    expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith('conv-001', 'AGENTS.md updated');
    expect(mockConversationState.emitEvent).toHaveBeenCalledWith('conv-001', 'conversation.configChanged', {
      changedFiles: ['AGENTS.md'],
    });

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 30 && parsed.result;
      } catch {
        return false;
      }
    });
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0]);
    expect(parsed.result).toEqual({ written: true });
  });

  it('handles agent.config.get', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());
    mockWorkspaceFactory.readAgentsMd.mockReturnValue('# Agents content');

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 31,
          method: 'agent.config.get',
          params: {},
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 31 && parsed.result;
      } catch {
        return false;
      }
    });
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0]);
    expect(parsed.result).toBe('# Agents content');
  });

  it('handles agent.config.delete', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 32,
          method: 'agent.config.delete',
          params: {},
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(mockWorkspaceFactory.deleteAgentsMd).toHaveBeenCalledWith('conv-001');
    expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith('conv-001', 'AGENTS.md deleted');
    expect(mockConversationState.emitEvent).toHaveBeenCalledWith('conv-001', 'conversation.configChanged', {
      changedFiles: ['AGENTS.md'],
    });

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 32 && parsed.result;
      } catch {
        return false;
      }
    });
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0]);
    expect(parsed.result).toEqual({ deleted: true });
  });

  it('handles agent.config.write with missing content', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 33,
          method: 'agent.config.write',
          params: {},
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 33 && parsed.error?.message?.includes('Missing content');
      } catch {
        return false;
      }
    });
    expect(errorCall).toBeDefined();
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
