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
    debug: vi.fn(),
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
  let mockConversationState: any;
  let router: WSRouter;

  let mockConfigService: any;
  let mockAgentService: any;
  let mockSkillService: any;
  let mockConversationService: any;
  let mockFileService: any;
  let mockSessionService: any;
  let mockMessageService: any;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();

    mockWss = createMockWSS();
    mockInstanceManager = {
      getInstance: vi.fn(),
      createInstance: vi.fn(),
      destroyInstance: vi.fn(),
      stopInstance: vi.fn(),
      restartInstance: vi.fn(),
      setSessionId: vi.fn(),
    };

    mockConversationState = {
      has: vi.fn().mockReturnValue(true),
      get: vi.fn().mockReturnValue({ status: 'running', ready: true, port: 30000 }),
      getRecentEvents: vi.fn().mockReturnValue([]),
      markNeedsRestart: vi.fn(),
      emitEvent: vi.fn(),
      subscribe: vi.fn().mockReturnValue(() => {}),
      transition: vi.fn(),
      cancelReadyCheck: vi.fn(),
      startReadyCheck: vi.fn(),
      setInstanceInfo: vi.fn(),
      setRunningInstance: vi.fn(),
      removeRunningInstance: vi.fn(),
      clearNeedsRestart: vi.fn(),
    };

    mockConfigService = {
      readConfig: vi.fn(),
      writeConfig: vi.fn(),
      patchConfig: vi.fn(),
    };

    mockAgentService = {
      writeAgent: vi.fn(),
      readAgent: vi.fn(),
      deleteAgent: vi.fn(),
      listAgents: vi.fn(),
      listAgentsWithRuntime: vi.fn(),
      writeAgentsMd: vi.fn(),
      readAgentsMd: vi.fn(),
      deleteAgentsMd: vi.fn(),
    };

    mockSkillService = {
      uploadSkill: vi.fn(),
      importSkill: vi.fn(),
      listSkills: vi.fn(),
      readSkill: vi.fn(),
      getSkillInfo: vi.fn(),
      deleteSkill: vi.fn(),
    };

    mockConversationService = {
      get: vi.fn().mockReturnValue({ id: 'conv-001', status: 'running', ready: true, port: 30000 }),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      delete: vi.fn(),
      create: vi.fn(),
      list: vi.fn(),
      getEvents: vi.fn(),
    };

    mockFileService = {
      write: vi.fn(),
      read: vi.fn().mockReturnValue('file content'),
      delete: vi.fn(),
      copy: vi.fn(),
      list: vi.fn().mockReturnValue(['file1.txt', 'file2.txt']),
    };

    mockSessionService = {
      create: vi.fn().mockResolvedValue({ id: 'ses_new' }),
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ id: 'ses_1' }),
      delete: vi.fn().mockResolvedValue(undefined),
      fork: vi.fn().mockResolvedValue({ id: 'forked' }),
      getChildren: vi.fn().mockResolvedValue([]),
      abort: vi.fn().mockResolvedValue({ aborted: true }),
      listProviders: vi.fn().mockResolvedValue({ providers: [], default: {} }),
    };

    mockMessageService = {
      send: vi.fn().mockResolvedValue({ messageId: 'msg_1', parts: [{ type: 'text', text: 'Hello' }] }),
      getHistory: vi.fn().mockResolvedValue([{ id: 'msg_1', text: 'Hello' }]),
    };

    router = new WSRouter(
      mockWss as any,
      mockConversationState,
      { heartbeatIntervalMs: 5000, idleTimeoutMs: 10000 },
      mockConfigService,
      mockAgentService,
      mockSkillService,
      mockConversationService,
      mockFileService,
      mockSessionService,
      mockMessageService
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
        listSessions: vi.fn().mockResolvedValue([]),
        getSession: vi.fn().mockResolvedValue({ id: 'ses_1' }),
        getSessionChildren: vi.fn().mockResolvedValue([]),
        forkSession: vi.fn().mockResolvedValue({ id: 'forked' }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
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

  it('replays recent events on connection', async () => {
    const mockWs = createMockWebSocket();
    mockConversationState.getRecentEvents.mockReturnValue([
      { type: 'conversation.prepared', id: 'conv-001', timestamp: 1000, payload: { status: 'prepared' } },
      { type: 'conversation.starting', id: 'conv-001', timestamp: 2000, payload: { status: 'starting' } },
    ]);

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const replayEvents = sendCalls.filter((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.method === 'conversation.prepared' || parsed.method === 'conversation.starting';
      } catch {
        return false;
      }
    });
    expect(replayEvents).toHaveLength(2);
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
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());
    mockMessageService.send.mockResolvedValue({ text: 'Hello' });

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

    expect(mockMessageService.send).toHaveBeenCalledWith('conv-001', 'Hello', 'google/gemini', 'dev');

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
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

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

    expect(mockMessageService.send).toHaveBeenCalledWith('conv-001', 'Hello', undefined, undefined);
  });

  it('handles message.history', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

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

    expect(mockMessageService.getHistory).toHaveBeenCalledWith('conv-001', undefined, 10);

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

  it('handles message.history with custom sessionId', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'message.history',
          params: { sessionId: 'child_ses_1', limit: 20 },
        })
      )
    );

    await vi.advanceTimersByTimeAsync(10);

    expect(mockMessageService.getHistory).toHaveBeenCalledWith('conv-001', 'child_ses_1', 20);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 3 && parsed.result;
      } catch {
        return false;
      }
    });
    expect(resultCall).toBeDefined();
  });

  it('handles session.abort', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

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

    expect(mockSessionService.abort).toHaveBeenCalledWith('conv-001');

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
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

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

    expect(mockSessionService.create).toHaveBeenCalledWith('conv-001', { title: 'custom', parentID: 'ses_1' });

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
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());
    mockSessionService.create.mockRejectedValue(new Error('not running'));

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
    mockMessageService.send.mockRejectedValue(new Error('Instance not available'));

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
    mockSkillService.listSkills.mockReturnValue(['web-search', 'code-review']);

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
    mockSkillService.readSkill.mockReturnValue('# web-search\nA skill.');

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
    mockSkillService.getSkillInfo.mockReturnValue({
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

    expect(mockSkillService.deleteSkill).toHaveBeenCalledWith('conv-001', 'web-search', undefined);

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
    mockSkillService.importSkill.mockImplementation(() => { throw new Error('Invalid skill name: foo/bar'); });

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

    expect(mockSkillService.importSkill).toHaveBeenCalledWith('conv-001', 'skills/test', 'foo/bar', undefined);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 24 && parsed.error;
      } catch {
        return false;
      }
    });
    expect(errorCall).toBeDefined();
  });

  it('handles skills.import with source from sibling prefix path skills_evil/', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());
    mockSkillService.importSkill.mockImplementation(() => {
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

    expect(mockSkillService.importSkill).toHaveBeenCalledWith('conv-001', 'skills_evil/web-search', 'web-search', undefined);

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

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 25 && parsed.error;
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

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 26 && parsed.error;
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

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find((call) => {
      try {
        const parsed = JSON.parse(call[0]);
        return parsed.id === 27 && parsed.error;
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

    expect(mockAgentService.writeAgentsMd).toHaveBeenCalledWith('conv-001', '# Agents\nDesigner agent.');

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
    mockAgentService.readAgentsMd.mockReturnValue('# Agents content');

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

    expect(mockAgentService.deleteAgentsMd).toHaveBeenCalledWith('conv-001');

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

  // ─── Config methods ─────────────────────────────────────

  it('handles config.update', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 40, method: 'config.update',
      params: { config: { model: 'new/model' } },
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockConfigService.writeConfig).toHaveBeenCalledWith('conv-001', { model: 'new/model' });
    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 40 && p.result?.updated === true; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
  });

  it('handles config.update with missing config', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 41, method: 'config.update',
      params: {},
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 41 && p.error; } catch { return false; }
    });
    expect(errorCall).toBeDefined();
  });

  it('handles config.get', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());
    mockConfigService.readConfig.mockReturnValue({ model: 'test/model' });

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 42, method: 'config.get',
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 42 && p.result?.model === 'test/model'; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
  });

  // ─── Agent methods ─────────────────────────────────────

  it('handles agent.register', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 50, method: 'agent.register',
      params: { name: 'designer', content: 'Designer agent' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockAgentService.writeAgent).toHaveBeenCalledWith('conv-001', 'designer', 'Designer agent');
    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 50 && p.result?.registered === 'designer'; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
  });

  it('handles agent.register with missing name or content', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 51, method: 'agent.register',
      params: { name: 'designer' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 51 && p.error; } catch { return false; }
    });
    expect(errorCall).toBeDefined();
  });

  it('handles agent.list', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());
    mockAgentService.listAgentsWithRuntime.mockResolvedValue(['designer', 'coder']);

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 52, method: 'agent.list',
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 52 && p.result; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0]);
    expect(parsed.result).toEqual(['designer', 'coder']);
  });

  it('handles agent.get', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());
    mockAgentService.readAgent.mockReturnValue('Designer agent content');

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 53, method: 'agent.get',
      params: { name: 'designer' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 53 && p.result === 'Designer agent content'; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
  });

  it('handles agent.get with missing name', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 54, method: 'agent.get',
      params: {},
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 54 && p.error?.message?.includes('Missing name'); } catch { return false; }
    });
    expect(errorCall).toBeDefined();
  });

  it('handles agent.delete', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 55, method: 'agent.delete',
      params: { name: 'designer' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockAgentService.deleteAgent).toHaveBeenCalledWith('conv-001', 'designer');
    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 55 && p.result?.deleted === 'designer'; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
  });

  it('handles agent.delete with missing name', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 56, method: 'agent.delete',
      params: {},
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 56 && p.error?.message?.includes('Missing name'); } catch { return false; }
    });
    expect(errorCall).toBeDefined();
  });

  // ─── File methods ──────────────────────────────────────

  it('handles file.write', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 60, method: 'file.write',
      params: { path: 'test.txt', content: 'hello' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockFileService.write).toHaveBeenCalledWith('conv-001', 'test.txt', 'hello');
    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 60 && p.result?.written === 'test.txt'; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
  });

  it('handles file.write with missing path or content', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 61, method: 'file.write',
      params: { path: 'test.txt' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 61 && p.error?.message?.includes('Missing path or content'); } catch { return false; }
    });
    expect(errorCall).toBeDefined();
  });

  it('handles file.read', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 62, method: 'file.read',
      params: { path: 'test.txt' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 62 && p.result === 'file content'; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
  });

  it('handles file.read with missing path', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 63, method: 'file.read',
      params: {},
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 63 && p.error?.message?.includes('Missing path'); } catch { return false; }
    });
    expect(errorCall).toBeDefined();
  });

  it('handles file.delete', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 64, method: 'file.delete',
      params: { path: 'test.txt' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockFileService.delete).toHaveBeenCalledWith('conv-001', 'test.txt');
    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 64 && p.result?.deleted === 'test.txt'; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
  });

  it('handles file.delete with missing path', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 65, method: 'file.delete',
      params: {},
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 65 && p.error?.message?.includes('Missing path'); } catch { return false; }
    });
    expect(errorCall).toBeDefined();
  });

  it('handles file.list', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 66, method: 'file.list',
      params: { path: '.' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 66 && p.result; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
  });

  it('handles file.copy', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 67, method: 'file.copy',
      params: { source: 'src.txt', dest: 'dst.txt' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockFileService.copy).toHaveBeenCalledWith('conv-001', 'src.txt', 'dst.txt');
    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 67 && p.result?.copied === 'dst.txt'; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
  });

  it('handles file.copy with missing source or dest', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 68, method: 'file.copy',
      params: { source: 'src.txt' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 68 && p.error?.message?.includes('Missing source or dest'); } catch { return false; }
    });
    expect(errorCall).toBeDefined();
  });

  // ─── Session WS methods ────────────────────────────────

  it('handles session.list', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());
    mockSessionService.list.mockResolvedValue([{ id: 'ses_1' }]);

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 70, method: 'session.list',
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockSessionService.list).toHaveBeenCalledWith('conv-001');
    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 70; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
  });

  it('handles session.get', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 71, method: 'session.get',
      params: { sessionId: 'ses_1' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockSessionService.get).toHaveBeenCalledWith('conv-001', 'ses_1');
  });

  it('handles session.get with missing sessionId', async () => {
    const mockWs = createMockWebSocket();
    const instance = createMockInstance();
    mockInstanceManager.getInstance.mockReturnValue(instance);

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 72, method: 'session.get',
      params: {},
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 72 && p.error?.message?.includes('Missing sessionId'); } catch { return false; }
    });
    expect(errorCall).toBeDefined();
  });

  it('handles session.children', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 73, method: 'session.children',
      params: { sessionId: 'ses_1' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockSessionService.getChildren).toHaveBeenCalledWith('conv-001', 'ses_1');
  });

  it('handles session.fork', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 74, method: 'session.fork',
      params: { sessionId: 'ses_1', messageID: 'msg_1' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockSessionService.fork).toHaveBeenCalledWith('conv-001', 'ses_1', 'msg_1');
  });

  it('handles session.delete', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 75, method: 'session.delete',
      params: { sessionId: 'ses_1' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockSessionService.delete).toHaveBeenCalledWith('conv-001', 'ses_1');
    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 75 && p.result?.deleted === 'ses_1'; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
  });

  // ─── Ready guard ───────────────────────────────────────

  it('rejects message.send when ready=false', async () => {
    const mockWs = createMockWebSocket();
    mockMessageService.send.mockRejectedValue(new Error('not ready'));
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 80, method: 'message.send',
      params: { text: 'Hi' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 80 && p.error?.message?.includes('not ready'); } catch { return false; }
    });
    expect(errorCall).toBeDefined();
  });

  // ─── Conversation Lifecycle ────────────────────────────

  it('handles conversation.status', async () => {
    const mockWs = createMockWebSocket();
    mockConversationService.get.mockReturnValue({
      id: 'conv-001', status: 'running', ready: true, port: 30000, sessionId: 'ses_1',
    });
    mockConversationState.get.mockReturnValue({ lastError: undefined });

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 100, method: 'conversation.status',
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 100 && p.result; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0]);
    expect(parsed.result.status).toBe('running');
    expect(parsed.result.port).toBe(30000);
  });

  it('handles conversation.start', async () => {
    const mockWs = createMockWebSocket();
    mockConversationService.start.mockResolvedValue({ id: 'conv-001', status: 'running', port: 30000 });

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 101, method: 'conversation.start',
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockConversationService.start).toHaveBeenCalledWith('conv-001');

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 101 && p.result; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0]);
    expect(parsed.result.status).toBe('running');
  });

  it('rejects conversation.start when already running', async () => {
    const mockWs = createMockWebSocket();
    mockConversationService.start.mockRejectedValue(new Error('already starting or running'));

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 102, method: 'conversation.start',
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 102 && p.error?.message?.includes('already starting or running'); } catch { return false; }
    });
    expect(errorCall).toBeDefined();
  });

  it('handles conversation.stop', async () => {
    const mockWs = createMockWebSocket();
    mockConversationService.stop.mockResolvedValue(undefined);

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 103, method: 'conversation.stop',
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockConversationService.stop).toHaveBeenCalledWith('conv-001');

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 103 && p.result; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0]);
    expect(parsed.result.status).toBe('stopped');
  });

  it('rejects conversation.stop when not in running/starting/error status', async () => {
    const mockWs = createMockWebSocket();
    mockConversationService.stop.mockRejectedValue(new Error('Cannot stop'));

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 104, method: 'conversation.stop',
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 104 && p.error?.message?.includes('Cannot stop'); } catch { return false; }
    });
    expect(errorCall).toBeDefined();
  });

  it('handles conversation.restart in direct runtime', async () => {
    const mockWs = createMockWebSocket();
    mockConversationService.restart.mockResolvedValue({ id: 'conv-001', status: 'running', port: 30000 });

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 105, method: 'conversation.restart',
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockConversationService.restart).toHaveBeenCalledWith('conv-001');

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 105 && p.result; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0]);
    expect(parsed.result.status).toBe('running');
  });

  it('handles conversation.restart in docker runtime', async () => {
    const dockerMockWss = createMockWSS();
    const dockerWs = createMockWebSocket();
    mockConversationState.get.mockReturnValue({ status: 'running', ready: true });
    mockConversationService.restart.mockResolvedValue({ id: 'conv-001', status: 'running', port: 30000 });

    const dockerRouter = new WSRouter(
      dockerMockWss as any,
      mockConversationState,
      { heartbeatIntervalMs: 5000, idleTimeoutMs: 10000 },
      mockConfigService,
      mockAgentService,
      mockSkillService,
      mockConversationService,
      mockFileService,
      mockSessionService,
      mockMessageService
    );

    dockerMockWss.emit('connection', dockerWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    dockerWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 106, method: 'conversation.restart',
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockConversationService.restart).toHaveBeenCalledWith('conv-001');

    const sendCalls = dockerWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 106 && p.result; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0]);
    expect(parsed.result.status).toBe('running');

    dockerRouter.closeAll();
    expect(dockerRouter).toBeDefined();
  });

  // ─── Skills import success path ────────────────────────

  it('handles conversation.delete', async () => {
    const mockWs = createMockWebSocket();
    mockConversationService.delete.mockResolvedValue(undefined);

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 110, method: 'conversation.delete',
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockConversationService.delete).toHaveBeenCalledWith('conv-001');

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 110 && p.result?.deleted === true; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
  });

  it('rejects conversation.delete when not found', async () => {
    const mockWs = createMockWebSocket();
    mockConversationService.delete.mockRejectedValue(new Error('Conversation not found'));

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 111, method: 'conversation.delete',
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 111 && p.error?.message?.includes('Conversation not found'); } catch { return false; }
    });
    expect(errorCall).toBeDefined();
  });

  it('rejects conversation.restart when not allowed', async () => {
    const mockWs = createMockWebSocket();
    mockConversationService.restart.mockRejectedValue(new Error('Cannot restart conversation'));

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 112, method: 'conversation.restart',
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 112 && p.error?.message?.includes('Cannot restart conversation'); } catch { return false; }
    });
    expect(errorCall).toBeDefined();
  });

  it('handles conversation.status with lastError', async () => {
    const mockWs = createMockWebSocket();
    mockConversationService.get.mockReturnValue({
      id: 'conv-001', status: 'error', ready: false, port: undefined, sessionId: undefined,
    });
    mockConversationState.get.mockReturnValue({ lastError: 'port allocation failed' });

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 113, method: 'conversation.status',
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 113 && p.result?.status === 'error'; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
    const parsed = JSON.parse(resultCall![0]);
    expect(parsed.result.lastError).toBe('port allocation failed');
  });

  it('handles skills.import success', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 90, method: 'skills.import',
      params: { source: 'skills/test', name: 'test-skill' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    expect(mockSkillService.importSkill).toHaveBeenCalledWith('conv-001', 'skills/test', 'test-skill', undefined);
    const sendCalls = mockWs.send.mock.calls as string[][];
    const resultCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 90 && p.result?.imported === 'test-skill'; } catch { return false; }
    });
    expect(resultCall).toBeDefined();
  });

  it('handles skills.import with missing source or name', async () => {
    const mockWs = createMockWebSocket();
    mockInstanceManager.getInstance.mockReturnValue(createMockInstance());

    mockWss.emit('connection', mockWs, createMockReq('/ws/conv-001'));
    await vi.advanceTimersByTimeAsync(10);

    mockWs.emit('message', Buffer.from(JSON.stringify({
      jsonrpc: '2.0', id: 91, method: 'skills.import',
      params: { source: 'skills/test' },
    })));

    await vi.advanceTimersByTimeAsync(10);

    const sendCalls = mockWs.send.mock.calls as string[][];
    const errorCall = sendCalls.find(c => {
      try { const p = JSON.parse(c[0]); return p.id === 91 && p.error?.message?.includes('Missing source or name'); } catch { return false; }
    });
    expect(errorCall).toBeDefined();
  });
});
