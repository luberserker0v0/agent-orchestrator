import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ConversationService } from './conversation-service.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import type { K8sStatusReporter } from '../cluster/status-reporter.js';

describe('ConversationService', () => {
  let service: ConversationService;
  let mockInstanceManager: any;
  let mockConversationState: any;
  let mockWorkspaceFactory: any;
  let mockRuntimeManager: any;
  let mockServerConfig: any;
  const testId = 'conv-1';

  beforeEach(() => {
    mockInstanceManager = {
      createInstance: vi.fn(),
      destroyInstance: vi.fn().mockResolvedValue(undefined),
      preparePersistentDataDeletion: vi.fn().mockResolvedValue(undefined),
      deletePersistentData: vi.fn().mockResolvedValue(undefined),
      restartInstance: vi.fn(),
      stopInstance: vi.fn(),
      getInstance: vi.fn(),
      setSessionId: vi.fn(),
      listInstances: vi.fn().mockReturnValue([]),
    };

    mockConversationState = {
      has: vi.fn(),
      get: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      create: vi.fn(),
      transition: vi.fn(),
      getRecentEvents: vi.fn().mockReturnValue([]),
      setInstanceInfo: vi.fn(),
      setRunningInstance: vi.fn(),
      removeRunningInstance: vi.fn(),
      cancelReadyCheck: vi.fn(),
      startReadyCheck: vi.fn(),
      clearNeedsRestart: vi.fn(),
      remove: vi.fn(),
    };

    mockWorkspaceFactory = {
      create: vi.fn().mockResolvedValue({ id: '', path: '', opencodeDir: '', runtimeAccess: { type: 'local' as const, cwd: '' } }),
      destroy: vi.fn().mockResolvedValue(undefined),
    };

    mockRuntimeManager = {
      hasAgentType: vi.fn(),
      listAgentTypes: vi.fn().mockReturnValue(['opencode-direct']),
      getRuntimeValidity: vi.fn().mockReturnValue({ isValid: true }),
      getRuntime: vi.fn().mockReturnValue(undefined),
    };

    mockServerConfig = {
      host: '127.0.0.1',
      port: 8080,
    };

    service = new ConversationService(
      mockInstanceManager,
      mockConversationState,
      mockWorkspaceFactory,
      mockRuntimeManager,
      mockServerConfig,
      'opencode-direct',
    );
  });

  describe('create', () => {
    it.each(['a..b', 'a_b', 'Uppercase', '../escape', '-leading', 'trailing-']) (
      'rejects invalid conversation id %s',
      async (id) => {
        await expect(service.create(id)).rejects.toMatchObject({
          statusCode: 400,
          code: ErrorCodes.INVALID_CONVERSATION_ID,
        });
        expect(mockWorkspaceFactory.create).not.toHaveBeenCalled();
      },
    );

    it('should create a conversation with generated id', async () => {
      mockConversationState.has.mockReturnValue(false);
      mockRuntimeManager.hasAgentType.mockReturnValue(true);
      mockConversationState.create.mockReturnValue({
        id: 'gen-id',
        agentType: 'opencode-direct',
        status: 'prepared',
        ready: false,
        needsRestart: false,
        createdAt: 100,
        updatedAt: 100,
      });

      const result = await service.create();

      expect(mockWorkspaceFactory.create).toHaveBeenCalled();
      expect(mockConversationState.create).toHaveBeenCalled();
      expect(result.status).toBe('prepared');
    });

    it('should create a conversation with specified id and agentType', async () => {
      mockConversationState.has.mockReturnValue(false);
      mockRuntimeManager.hasAgentType.mockReturnValue(true);
      mockConversationState.create.mockReturnValue({
        id: testId,
        agentType: 'custom',
        status: 'prepared',
        ready: false,
        needsRestart: false,
        createdAt: 100,
        updatedAt: 100,
      });

      const result = await service.create(testId, 'custom');

      expect(result.id).toBe(testId);
      expect(result.agentType).toBe('custom');
    });

    it('should throw 409 when conversation already exists', async () => {
      mockConversationState.has.mockReturnValue(true);

      await expect(service.create(testId)).rejects.toThrow(AppError);
      await expect(service.create(testId)).rejects.toThrow(/already exists/);
    });

    it('should throw 400 for unknown agent type', async () => {
      mockConversationState.has.mockReturnValue(false);
      mockRuntimeManager.hasAgentType.mockReturnValue(false);

      await expect(service.create(testId, 'unknown')).rejects.toThrow(AppError);
    });

    it('should throw 400 when runtime is invalid', async () => {
      mockConversationState.has.mockReturnValue(false);
      mockRuntimeManager.hasAgentType.mockReturnValue(true);
      mockRuntimeManager.getRuntimeValidity.mockReturnValue({ isValid: false, error: 'Config validation failed' });

      await expect(service.create(testId, 'broken-rt')).rejects.toThrow(AppError);
      await expect(service.create(testId, 'broken-rt')).rejects.toThrow(/not available/);
    });

    it('serializes concurrent creates for the same conversation id', async () => {
      let exists = false;
      let releaseWorkspace!: () => void;
      const workspaceGate = new Promise<void>((resolve) => { releaseWorkspace = resolve; });
      mockConversationState.has.mockImplementation(() => exists);
      mockRuntimeManager.hasAgentType.mockReturnValue(true);
      mockWorkspaceFactory.create.mockImplementation(async () => {
        await workspaceGate;
        return { id: testId, path: '', opencodeDir: '', runtimeAccess: { type: 'local', cwd: '' } };
      });
      mockConversationState.create.mockImplementation(() => {
        exists = true;
        return {
          id: testId,
          agentType: 'opencode-direct',
          status: 'prepared',
          ready: false,
          needsRestart: false,
          createdAt: 100,
          updatedAt: 100,
        };
      });

      const first = service.create(testId);
      await vi.waitFor(() => expect(mockWorkspaceFactory.create).toHaveBeenCalledTimes(1));
      const second = service.create(testId);
      expect(mockWorkspaceFactory.create).toHaveBeenCalledTimes(1);
      releaseWorkspace();

      await expect(first).resolves.toMatchObject({ id: testId, status: 'prepared' });
      await expect(second).rejects.toMatchObject({ code: ErrorCodes.CONVERSATION_ALREADY_EXISTS });
      expect(mockWorkspaceFactory.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('get', () => {
    it('should return conversation data', () => {
      mockConversationState.get.mockReturnValue({
        id: testId,
        agentType: 'opencode-direct',
        status: 'prepared',
        ready: false,
        needsRestart: false,
        createdAt: 100,
        updatedAt: 100,
      });

      const result = service.get(testId);
      expect(result.id).toBe(testId);
    });

    it('should throw 404 when not found', () => {
      mockConversationState.get.mockReturnValue(undefined);

      expect(() => service.get(testId)).toThrow(AppError);
      try { service.get(testId); } catch (e: any) {
        expect(e.statusCode).toBe(404);
      }
    });
  });

  describe('list', () => {
    it('should return all conversations', () => {
      mockConversationState.list.mockReturnValue([
        { id: 'a', agentType: 'opencode-direct', status: 'prepared', ready: false, needsRestart: false, createdAt: 1, updatedAt: 1 },
        { id: 'b', agentType: 'opencode-direct', status: 'running', ready: true, needsRestart: false, createdAt: 2, updatedAt: 2 },
      ]);

      const result = service.list();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('a');
    });
  });

  describe('getEvents', () => {
    it('should return events for existing conversation', () => {
      mockConversationState.has.mockReturnValue(true);
      mockConversationState.getRecentEvents.mockReturnValue([{ type: 'test', id: '1', timestamp: 100, payload: {} }]);

      const events = service.getEvents(testId);
      expect(events).toHaveLength(1);
    });

    it('should throw 404 for missing conversation', () => {
      mockConversationState.has.mockReturnValue(false);

      expect(() => service.getEvents(testId)).toThrow(AppError);
    });
  });

  describe('start', () => {
    const mockState = {
      id: testId,
      agentType: 'opencode-direct',
      status: 'prepared',
      ready: false,
    };

    beforeEach(() => {
      mockConversationState.get.mockReset();
      mockInstanceManager.createInstance.mockReset();
    });

    it('should start a prepared conversation', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState });
      mockInstanceManager.createInstance.mockResolvedValue({
        port: 41001,
        process: {},
        client: { createSession: vi.fn().mockResolvedValue({ id: 'ses_1' }) },
      });

      const result = await service.start(testId);

      expect(mockConversationState.cancelReadyCheck).toHaveBeenCalledWith(testId);
      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'starting');
      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'running');
      expect(result.status).toBe('running');
      expect(result.port).toBe(41001);
    });

    it('should track instance status on start when reporter is configured', async () => {
      const mockReporter = { trackInstance: vi.fn(), untrackInstance: vi.fn() };
      const svc = new ConversationService(
        mockInstanceManager,
        mockConversationState,
        mockWorkspaceFactory,
        mockRuntimeManager,
        mockServerConfig,
        'opencode-direct',
        undefined,
        mockReporter as any,
        (agentTypeId: string) => (agentTypeId === 'opencode-direct' ? 'direct' : undefined),
      );
      mockConversationState.get.mockReturnValue({ ...mockState });
      mockInstanceManager.createInstance.mockResolvedValue({
        port: 41001,
        baseUrl: 'http://127.0.0.1:41001',
        client: { createSession: vi.fn().mockResolvedValue({ id: 'ses_1' }) },
      });

      await svc.start(testId);

      expect(mockReporter.trackInstance).toHaveBeenCalledWith({
        conversationId: testId,
        runtimeType: 'direct',
        endpoint: 'http://127.0.0.1:41001',
        volumeClaimName: 'conv-conv-1',
      });
    });

    it('should report quota errors from background session creation', async () => {
      const mockReporter = { trackInstance: vi.fn(), untrackInstance: vi.fn(), reportQuotaError: vi.fn() };
      const svc = new ConversationService(
        mockInstanceManager,
        mockConversationState,
        mockWorkspaceFactory,
        mockRuntimeManager,
        mockServerConfig,
        'opencode-direct',
        undefined,
        mockReporter as any,
      );
      mockConversationState.get.mockReturnValue({ ...mockState });
      const quotaError = new AppError(429, ErrorCodes.LLM_QUOTA_EXHAUSTED, 'OpenCode HTTP 429: quota exceeded');
      mockInstanceManager.createInstance.mockResolvedValue({
        port: 41001,
        client: { createSession: vi.fn().mockRejectedValue(quotaError) },
      });

      await svc.start(testId);
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockReporter.reportQuotaError).toHaveBeenCalledWith(
        testId,
        expect.objectContaining({ code: ErrorCodes.LLM_QUOTA_EXHAUSTED })
      );
    });

    it('should throw 404 when conversation not found', async () => {
      mockConversationState.get.mockReturnValue(undefined);

      await expect(service.start(testId)).rejects.toThrow(AppError);
      try { await service.start(testId); } catch (e: any) {
        expect(e.statusCode).toBe(404);
      }
    });

    it('should throw 409 when already running', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'running' });

      await expect(service.start(testId)).rejects.toThrow(AppError);
      try { await service.start(testId); } catch (e: any) {
        expect(e.statusCode).toBe(409);
      }
    });

    it('should throw 409 when already starting', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'starting' });

      await expect(service.start(testId)).rejects.toThrow(AppError);
    });

    it('should throw 409 when restarting (bug fix guard)', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'restarting' });

      await expect(service.start(testId)).rejects.toThrow(AppError);
    });

    it('should throw 409 when destroyed', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'destroyed' });

      await expect(service.start(testId)).rejects.toThrow(AppError);
      try { await service.start(testId); } catch (e: any) {
        expect(e.statusCode).toBe(409);
      }
      expect(mockInstanceManager.createInstance).not.toHaveBeenCalled();
      expect(mockConversationState.transition).not.toHaveBeenCalled();
    });

    it('should start from stopped state', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'stopped' });
      mockInstanceManager.createInstance.mockResolvedValue({
        port: 41006,
        process: {},
        client: { createSession: vi.fn().mockResolvedValue({ id: 'ses_6' }) },
      });

      const result = await service.start(testId);

      expect(result.status).toBe('running');
      expect(mockConversationState.cancelReadyCheck).toHaveBeenCalledWith(testId);
    });

    it('should start from error state', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'error' });
      mockInstanceManager.createInstance.mockResolvedValue({
        port: 41007,
        process: {},
        client: { createSession: vi.fn().mockResolvedValue({ id: 'ses_7' }) },
      });

      const result = await service.start(testId);

      expect(result.status).toBe('running');
    });

    it('should transition to error on instance creation failure', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState });
      mockInstanceManager.createInstance.mockRejectedValue(new Error('port busy'));

      await expect(service.start(testId)).rejects.toThrow(AppError);
      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'error', { error: 'port busy' });
    });
  });

  describe('stop', () => {
    beforeEach(() => {
      mockConversationState.get.mockReset();
    });

    it('should stop a running conversation', async () => {
      mockConversationState.get.mockReturnValue({ id: testId, status: 'running' });
      mockInstanceManager.destroyInstance.mockResolvedValue(undefined);

      await service.stop(testId);

      expect(mockConversationState.cancelReadyCheck).toHaveBeenCalledWith(testId);
      expect(mockInstanceManager.destroyInstance).toHaveBeenCalledWith(testId);
      expect(mockConversationState.removeRunningInstance).toHaveBeenCalledWith(testId);
      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'stopped');
    });

    it('should mark the instance Stopped (not delete it) when reporter is configured', async () => {
      const mockReporter = { trackInstance: vi.fn(), reportStopped: vi.fn(), untrackInstance: vi.fn() };
      const svc = new ConversationService(
        mockInstanceManager,
        mockConversationState,
        mockWorkspaceFactory,
        mockRuntimeManager,
        mockServerConfig,
        'opencode-direct',
        undefined,
        mockReporter as any,
      );
      mockConversationState.get.mockReturnValue({ id: testId, status: 'running' });
      mockInstanceManager.destroyInstance.mockResolvedValue(undefined);

      await svc.stop(testId);

      expect(mockReporter.reportStopped).toHaveBeenCalledWith(testId);
      expect(mockReporter.untrackInstance).not.toHaveBeenCalled();
    });

    it('should throw 404 when not found', async () => {
      mockConversationState.get.mockReturnValue(undefined);

      await expect(service.stop(testId)).rejects.toThrow(AppError);
    });

    it('should throw 409 when in prepared status', async () => {
      mockConversationState.get.mockReturnValue({ id: testId, status: 'prepared' });

      await expect(service.stop(testId)).rejects.toThrow(AppError);
    });

    it('should throw 409 when in stopped status', async () => {
      mockConversationState.get.mockReturnValue({ id: testId, status: 'stopped' });

      await expect(service.stop(testId)).rejects.toThrow(AppError);
    });

    it('should throw 409 when in restarting status', async () => {
      mockConversationState.get.mockReturnValue({ id: testId, status: 'restarting' });

      await expect(service.stop(testId)).rejects.toThrow(AppError);
    });

    it('should throw 409 when in destroyed status', async () => {
      mockConversationState.get.mockReturnValue({ id: testId, status: 'destroyed' });

      await expect(service.stop(testId)).rejects.toThrow(AppError);
    });
  });

  describe('restart', () => {
    const mockState = {
      id: testId,
      agentType: 'opencode-direct',
      status: 'stopped',
      ready: false,
    };

    beforeEach(() => {
      mockConversationState.get.mockReset();
      mockInstanceManager.createInstance.mockReset();
      mockInstanceManager.restartInstance.mockReset();
      mockInstanceManager.getInstance.mockReset();
    });

    it('should restart a stopped conversation', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState });
      mockInstanceManager.createInstance.mockResolvedValue({
        port: 41002,
        process: {},
        client: { createSession: vi.fn().mockResolvedValue({ id: 'ses_2' }) },
      });

      const result = await service.restart(testId);

      expect(mockConversationState.cancelReadyCheck).toHaveBeenCalledWith(testId);
      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'restarting');
      expect(result.status).toBe('running');
    });

    it('should resume the previous session when the server still has it', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'running', sessionId: 'ses_old' });
      const mockClient = {
        getSession: vi.fn().mockResolvedValue({ id: 'ses_old' }),
        createSession: vi.fn(),
      };
      mockInstanceManager.getInstance.mockReturnValue({ port: 41004, client: mockClient });
      mockInstanceManager.restartInstance.mockResolvedValue(undefined);

      await service.restart(testId);
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockClient.getSession).toHaveBeenCalledWith('ses_old');
      expect(mockClient.createSession).not.toHaveBeenCalled();
      expect(mockConversationState.setInstanceInfo).toHaveBeenCalledWith(testId, { sessionId: 'ses_old' });
      expect(mockInstanceManager.setSessionId).toHaveBeenCalledWith(testId, 'ses_old');
    });

    it('should create a fresh session when the previous session is gone', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'running', sessionId: 'ses_gone' });
      const mockClient = {
        getSession: vi.fn().mockRejectedValue(new Error('not found')),
        createSession: vi.fn().mockResolvedValue({ id: 'ses_new' }),
      };
      mockInstanceManager.getInstance.mockReturnValue({ port: 41004, client: mockClient });
      mockInstanceManager.restartInstance.mockResolvedValue(undefined);

      await service.restart(testId);
      await new Promise((resolve) => setImmediate(resolve));

      expect(mockClient.getSession).toHaveBeenCalledWith('ses_gone');
      expect(mockClient.createSession).toHaveBeenCalledWith({ title: `AgentOrchestrator-${testId}` });
      expect(mockConversationState.setInstanceInfo).toHaveBeenCalledWith(testId, { sessionId: 'ses_new' });
      expect(mockInstanceManager.setSessionId).toHaveBeenCalledWith(testId, 'ses_new');
    });

    it('should throw 404 when not found', async () => {
      mockConversationState.get.mockReturnValue(undefined);

      await expect(service.restart(testId)).rejects.toThrow(AppError);
    });

    it('should throw 409 when in prepared status', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'prepared' });

      await expect(service.restart(testId)).rejects.toThrow(AppError);
    });

    it('should throw 409 when in starting status', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'starting' });

      await expect(service.restart(testId)).rejects.toThrow(AppError);
    });

    it('should throw 409 when in restarting status', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'restarting' });

      await expect(service.restart(testId)).rejects.toThrow(AppError);
    });

    it('should throw 409 when in destroyed status', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'destroyed' });

      await expect(service.restart(testId)).rejects.toThrow(AppError);
    });

    it('should stop then create new instance when restart fails', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'running' });
      mockInstanceManager.getInstance.mockReturnValue({ port: 41002, client: {} });
      mockInstanceManager.restartInstance.mockRejectedValue(new Error('restart failed'));
      mockInstanceManager.destroyInstance.mockResolvedValue(undefined);
      mockInstanceManager.createInstance.mockResolvedValue({
        port: 41003,
        process: {},
        client: { createSession: vi.fn().mockResolvedValue({ id: 'ses_3' }) },
      });

      await service.restart(testId);

      expect(mockConversationState.cancelReadyCheck).toHaveBeenCalledWith(testId);
      expect(mockInstanceManager.restartInstance).toHaveBeenCalledWith(testId, 'opencode-direct');
      expect(mockInstanceManager.destroyInstance).toHaveBeenCalledWith(testId);
      expect(mockInstanceManager.createInstance).toHaveBeenCalledWith(testId, 'opencode-direct');
    });

    it('should use restartInstance when supported', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'running' });
      mockInstanceManager.restartInstance.mockResolvedValue(undefined);
      mockInstanceManager.getInstance.mockReturnValue({
        port: 41004,
        process: {},
        client: { createSession: vi.fn().mockResolvedValue({ id: 'ses_4' }) },
      });

      await service.restart(testId);

      expect(mockConversationState.cancelReadyCheck).toHaveBeenCalledWith(testId);
      expect(mockInstanceManager.restartInstance).toHaveBeenCalledWith(testId, 'opencode-direct');
    });

    it('should pass the conversation agent type (not the default) to restartInstance', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'running', agentType: 'opencode-k8s' });
      mockInstanceManager.restartInstance.mockResolvedValue(undefined);
      mockInstanceManager.getInstance.mockReturnValue({
        port: 41004,
        process: {},
        client: { createSession: vi.fn().mockResolvedValue({ id: 'ses_4' }) },
      });

      await service.restart(testId);

      expect(mockInstanceManager.restartInstance).toHaveBeenCalledWith(testId, 'opencode-k8s');
    });

    it('should transition to error on failure', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState });
      mockInstanceManager.createInstance.mockRejectedValue(new Error('no ports'));

      await expect(service.restart(testId)).rejects.toThrow();
      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'error', { error: 'no ports' });
    });

    it('should restart from error state using createInstance', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'error' });
      mockInstanceManager.createInstance.mockResolvedValue({
        port: 41005,
        process: {},
        client: { createSession: vi.fn().mockResolvedValue({ id: 'ses_5' }) },
      });

      const result = await service.restart(testId);

      expect(mockConversationState.cancelReadyCheck).toHaveBeenCalledWith(testId);
      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'restarting');
      expect(mockInstanceManager.getInstance).toHaveBeenCalledWith(testId);
      expect(mockInstanceManager.restartInstance).not.toHaveBeenCalled();
      expect(mockInstanceManager.createInstance).toHaveBeenCalledWith(testId, 'opencode-direct');
      expect(result.status).toBe('running');
    });
  });

  describe('migrate', () => {
    const mockState = {
      id: testId,
      agentType: 'opencode-k8s',
      status: 'running',
      ready: true,
      sessionId: 'ses_old',
    };

    beforeEach(() => {
      mockConversationState.get.mockReset();
      mockConversationState.emitEvent = vi.fn();
      mockInstanceManager.createInstance.mockReset();
      mockInstanceManager.restartInstance.mockReset();
      mockInstanceManager.getInstance.mockReset();
      mockRuntimeManager.getRuntime.mockReset();
    });

    function k8sService() {
      const placeable = { setNodeOverride: vi.fn(), clearNodeOverride: vi.fn() };
      mockRuntimeManager.getRuntime.mockReturnValue(placeable);
      const svc = new ConversationService(
        mockInstanceManager,
        mockConversationState,
        mockWorkspaceFactory,
        mockRuntimeManager,
        mockServerConfig,
        'opencode-direct',
        undefined,
        undefined,
        () => 'kubernetes',
      );
      return { svc, placeable };
    }

    it('should throw 404 when not found', async () => {
      mockConversationState.get.mockReturnValue(undefined);
      const { svc } = k8sService();

      await expect(svc.migrateInstance(testId, { nodeName: 'n2' })).rejects.toThrow(AppError);
    });

    it('should throw 409 when not running', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'stopped' });
      const { svc } = k8sService();

      await expect(svc.migrateInstance(testId, { nodeName: 'n2' })).rejects.toThrow(AppError);
      try {
        await svc.migrateInstance(testId, { nodeName: 'n2' });
      } catch (e: any) {
        expect(e.statusCode).toBe(409);
      }
    });

    it('should throw 400 for missing nodeName', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState });
      const { svc } = k8sService();

      await expect(svc.migrateInstance(testId, { nodeName: '' })).rejects.toThrow(AppError);
    });

    it('should throw 400 when runtime is not placeable', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState });
      mockRuntimeManager.getRuntime.mockReturnValue({});
      const svc = new ConversationService(
        mockInstanceManager,
        mockConversationState,
        mockWorkspaceFactory,
        mockRuntimeManager,
        mockServerConfig,
        'opencode-direct',
        undefined,
        undefined,
        () => 'direct',
      );

      try {
        await svc.migrateInstance(testId, { nodeName: 'n2' });
        expect.unreachable('migrateInstance should have thrown');
      } catch (e: any) {
        expect(e.code).toBe(ErrorCodes.MIGRATION_NOT_SUPPORTED);
        expect(e.statusCode).toBe(400);
      }
    });

    it('should migrate and resume the previous session', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState });
      const mockClient = {
        getSession: vi.fn().mockResolvedValue({ id: 'ses_old' }),
        createSession: vi.fn(),
      };
      mockInstanceManager.getInstance.mockReturnValue({
        port: 41004,
        baseUrl: 'http://127.0.0.1:41004',
        client: mockClient,
      });
      mockInstanceManager.restartInstance.mockResolvedValue(undefined);
      const mockReporter = { trackInstance: vi.fn(), untrackInstance: vi.fn(), reportMoved: vi.fn() };
      const placeable = { setNodeOverride: vi.fn(), clearNodeOverride: vi.fn() };
      mockRuntimeManager.getRuntime.mockReturnValue(placeable);
      const svc = new ConversationService(
        mockInstanceManager,
        mockConversationState,
        mockWorkspaceFactory,
        mockRuntimeManager,
        mockServerConfig,
        'opencode-direct',
        undefined,
        mockReporter as any,
        () => 'kubernetes',
      );

      const result = await svc.migrateInstance(testId, { nodeName: 'worker-2' });

      expect(placeable.setNodeOverride).toHaveBeenCalledWith(testId, 'worker-2');
      expect(placeable.clearNodeOverride).toHaveBeenCalledWith(testId);
      expect(mockClient.getSession).toHaveBeenCalledWith('ses_old');
      expect(mockClient.createSession).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'running', nodeName: 'worker-2', resumed: true, sessionId: 'ses_old' });
      expect(mockConversationState.emitEvent).toHaveBeenCalledWith(
        testId,
        'conversation.migrated',
        expect.objectContaining({ nodeName: 'worker-2', resumed: true, sessionId: 'ses_old' }),
      );
      expect(mockReporter.reportMoved).toHaveBeenCalledWith(testId, {
        endpoint: 'http://127.0.0.1:41004',
        nodeName: 'worker-2',
      });
    });

    it('should create a fresh session when resume fails', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState });
      const mockClient = {
        getSession: vi.fn().mockRejectedValue(new Error('gone')),
        createSession: vi.fn().mockResolvedValue({ id: 'ses_new' }),
      };
      mockInstanceManager.getInstance.mockReturnValue({ port: 41004, client: mockClient });
      mockInstanceManager.restartInstance.mockResolvedValue(undefined);
      const { svc, placeable } = k8sService();

      const result = await svc.migrateInstance(testId, { nodeName: 'worker-2' });

      expect(result.resumed).toBe(false);
      expect(result.sessionId).toBe('ses_new');
      expect(placeable.clearNodeOverride).toHaveBeenCalledWith(testId);
    });

    it('should transition to error and clear override on failure', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState });
      mockInstanceManager.getInstance.mockReturnValue({ port: 41004, client: {} });
      mockInstanceManager.restartInstance.mockRejectedValue(new Error('boom'));
      mockInstanceManager.destroyInstance.mockResolvedValue(undefined);
      mockInstanceManager.createInstance.mockRejectedValue(new Error('boom'));
      const { svc, placeable } = k8sService();

      await expect(svc.migrateInstance(testId, { nodeName: 'n2' })).rejects.toThrow();
      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'error', { error: 'boom' });
      expect(placeable.clearNodeOverride).toHaveBeenCalledWith(testId);
    });
  });

  describe('delete', () => {
    it('should untrack instance status on delete when reporter is configured', async () => {
      const mockReporter = { trackInstance: vi.fn(), untrackInstance: vi.fn() };
      const svc = new ConversationService(
        mockInstanceManager,
        mockConversationState,
        mockWorkspaceFactory,
        mockRuntimeManager,
        mockServerConfig,
        'opencode-direct',
        undefined,
        mockReporter as any,
      );
      mockConversationState.has.mockReturnValue(true);
      mockInstanceManager.getInstance.mockReturnValue(undefined);

      await svc.delete(testId);

      expect(mockReporter.untrackInstance).toHaveBeenCalledWith(testId);
    });

    it('should delete a conversation', async () => {
      mockConversationState.has.mockReturnValue(true);
      mockConversationState.get.mockReturnValue({ agentType: 'opencode-k8s' });
      mockInstanceManager.destroyInstance.mockResolvedValue(undefined);

      await service.delete(testId);

      expect(mockInstanceManager.destroyInstance).toHaveBeenCalledWith(testId);
      expect(mockInstanceManager.preparePersistentDataDeletion).toHaveBeenCalledWith(testId, 'opencode-k8s');
      expect(mockInstanceManager.deletePersistentData).toHaveBeenCalledWith(testId, 'opencode-k8s');
      expect(mockInstanceManager.preparePersistentDataDeletion.mock.invocationCallOrder[0])
        .toBeLessThan(mockInstanceManager.destroyInstance.mock.invocationCallOrder[0]);
      expect(mockWorkspaceFactory.destroy).toHaveBeenCalledWith(testId);
      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'destroyed');
      expect(mockConversationState.remove).toHaveBeenCalledWith(testId);
    });

    it('leaves persistent data pending when the runtime cannot be stopped', async () => {
      mockConversationState.has.mockReturnValue(true);
      mockInstanceManager.destroyInstance.mockRejectedValue(new Error('kill failed'));

      await expect(service.delete(testId)).rejects.toMatchObject({
        code: ErrorCodes.PERSISTENT_DATA_CLEANUP_PENDING,
      });

      expect(mockInstanceManager.deletePersistentData).not.toHaveBeenCalled();
      expect(mockWorkspaceFactory.destroy).not.toHaveBeenCalled();
      expect(mockConversationState.remove).not.toHaveBeenCalled();
    });

    it('should retain conversation state on workspace destruction failure', async () => {
      const { logger } = await import('../utils/logger.js');
      mockConversationState.has.mockReturnValue(true);
      mockInstanceManager.destroyInstance.mockResolvedValue(undefined);
      mockWorkspaceFactory.destroy.mockImplementation(() => { throw new Error('permission denied'); });

      await expect(service.delete(testId)).rejects.toThrow('permission denied');

      expect(logger.warn).toHaveBeenCalled();
      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'error', { error: 'permission denied' });
      expect(mockConversationState.remove).not.toHaveBeenCalled();
    });

    it('marks the Kubernetes instance record before stopping the runtime', async () => {
      const mockReporter = {
        markPersistentDataDeletePending: vi.fn().mockResolvedValue(undefined),
        untrackInstance: vi.fn().mockResolvedValue(undefined),
      };
      const svc = new ConversationService(
        mockInstanceManager,
        mockConversationState,
        mockWorkspaceFactory,
        mockRuntimeManager,
        mockServerConfig,
        'opencode-k8s',
        undefined,
        mockReporter as unknown as K8sStatusReporter,
        () => 'kubernetes',
      );
      mockConversationState.has.mockReturnValue(true);
      mockConversationState.get.mockReturnValue({ agentType: 'opencode-k8s' });

      await svc.delete(testId);

      expect(mockReporter.markPersistentDataDeletePending).toHaveBeenCalledWith(testId);
      expect(mockInstanceManager.preparePersistentDataDeletion.mock.invocationCallOrder[0])
        .toBeLessThan(mockReporter.markPersistentDataDeletePending.mock.invocationCallOrder[0]);
      expect(mockReporter.markPersistentDataDeletePending.mock.invocationCallOrder[0])
        .toBeLessThan(mockInstanceManager.destroyInstance.mock.invocationCallOrder[0]);
    });

    it('keeps the Kubernetes runtime alive when its instance deletion marker fails', async () => {
      const mockReporter = {
        markPersistentDataDeletePending: vi.fn().mockRejectedValue(new Error('CR update failed')),
        untrackInstance: vi.fn(),
      };
      const svc = new ConversationService(
        mockInstanceManager,
        mockConversationState,
        mockWorkspaceFactory,
        mockRuntimeManager,
        mockServerConfig,
        'opencode-k8s',
        undefined,
        mockReporter as unknown as K8sStatusReporter,
        () => 'kubernetes',
      );
      mockConversationState.has.mockReturnValue(true);
      mockConversationState.get.mockReturnValue({ agentType: 'opencode-k8s' });

      await expect(svc.delete(testId)).rejects.toMatchObject({
        code: ErrorCodes.PERSISTENT_DATA_CLEANUP_PENDING,
      });
      expect(mockInstanceManager.destroyInstance).not.toHaveBeenCalled();
      expect(mockConversationState.remove).not.toHaveBeenCalled();
    });

    it('keeps the conversation intact when deletion intent cannot be persisted', async () => {
      mockConversationState.has.mockReturnValue(true);
      mockConversationState.get.mockReturnValue({ agentType: 'opencode-direct' });
      mockInstanceManager.preparePersistentDataDeletion.mockRejectedValue(new Error('metadata unavailable'));

      await expect(service.delete(testId)).rejects.toMatchObject({
        code: ErrorCodes.PERSISTENT_DATA_CLEANUP_PENDING,
      });

      expect(mockInstanceManager.destroyInstance).not.toHaveBeenCalled();
      expect(mockInstanceManager.deletePersistentData).not.toHaveBeenCalled();
      expect(mockConversationState.remove).not.toHaveBeenCalled();
    });

    it('should throw 404 when not found', async () => {
      mockConversationState.has.mockReturnValue(false);

      await expect(service.delete(testId)).rejects.toThrow(AppError);
    });
  });

  // ─── Robustness Tests ─────────────────────────────────────────
  describe('robustness', () => {
    const makeState = (status: string) => ({
      id: testId, agentType: 'opencode-direct', status, ready: false,
    });

    const createMockClient = () => ({ createSession: vi.fn().mockResolvedValue({ id: 'ses_1' }) });

    const makeInstance = (port = 41001) => ({
      port, process: {}, client: createMockClient(),
    });

    // ── Part 1: 循環暴力測試 ─────────────────────────────────────
    describe('brute force cycles (10x each)', () => {
      it('start x10 on prepared → first succeeds, rest rejected', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('prepared'))
          .mockReturnValue(makeState('running'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());

        let successCount = 0;
        let rejectCount = 0;
        for (let i = 0; i < 10; i++) {
          try {
            const result = await service.start(testId);
            expect(result.status).toBe('running');
            successCount++;
          } catch (e: any) {
            expect(e.statusCode).toBe(409);
            rejectCount++;
          }
        }
        expect(successCount).toBe(1);
        expect(rejectCount).toBe(9);
        expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(1);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'starting');
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'running');
      });

      it('start x10 on running → all rejected, state unchanged', async () => {
        mockConversationState.get.mockReturnValue(makeState('running'));

        for (let i = 0; i < 10; i++) {
          await expect(service.start(testId)).rejects.toThrow(AppError);
        }
        expect(mockInstanceManager.createInstance).not.toHaveBeenCalled();
        expect(mockConversationState.transition).not.toHaveBeenCalledWith(testId, 'starting');
      });

      it('start x10 on stopped → first succeeds, rest rejected', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('stopped'))
          .mockReturnValue(makeState('running'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());

        let successCount = 0;
        for (let i = 0; i < 10; i++) {
          try {
            await service.start(testId);
            successCount++;
          } catch { /* expected */ }
        }
        expect(successCount).toBe(1);
        expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(1);
      });

      it('start x10 on destroyed → all rejected', async () => {
        mockConversationState.get.mockReturnValue(makeState('destroyed'));

        for (let i = 0; i < 10; i++) {
          await expect(service.start(testId)).rejects.toThrow(AppError);
        }
        expect(mockInstanceManager.createInstance).not.toHaveBeenCalled();
      });

      it('stop x10 on running → first succeeds, rest rejected', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('running'))
          .mockReturnValue(makeState('stopped'));
        mockInstanceManager.destroyInstance.mockResolvedValue(undefined);

        let successCount = 0;
        for (let i = 0; i < 10; i++) {
          try {
            await service.stop(testId);
            successCount++;
          } catch { /* expected */ }
        }
        expect(successCount).toBe(1);
        expect(mockInstanceManager.destroyInstance).toHaveBeenCalledTimes(1);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'stopped');
      });

      it('stop x10 on prepared → all rejected', async () => {
        mockConversationState.get.mockReturnValue(makeState('prepared'));

        for (let i = 0; i < 10; i++) {
          await expect(service.stop(testId)).rejects.toThrow(AppError);
        }
        expect(mockInstanceManager.destroyInstance).not.toHaveBeenCalled();
      });

      it('stop x10 on stopped → all rejected', async () => {
        mockConversationState.get.mockReturnValue(makeState('stopped'));

        for (let i = 0; i < 10; i++) {
          await expect(service.stop(testId)).rejects.toThrow(AppError);
        }
      });

      it('restart x10 on running → all succeed (restart from running is valid)', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('running'))
          .mockReturnValue(makeState('running'));
        mockInstanceManager.getInstance.mockReturnValue(makeInstance());
        mockInstanceManager.restartInstance.mockResolvedValue(undefined);

        let successCount = 0;
        for (let i = 0; i < 10; i++) {
          await service.restart(testId);
          successCount++;
        }
        expect(successCount).toBe(10);
        expect(mockInstanceManager.restartInstance).toHaveBeenCalledTimes(10);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'restarting');
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'running');
      });

      it('restart x10 on stopped → all succeed via createInstance', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('stopped'))
          .mockReturnValue(makeState('running'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());

        let successCount = 0;
        for (let i = 0; i < 10; i++) {
          await service.restart(testId);
          successCount++;
        }
        expect(successCount).toBe(10);
        expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(10);
      });

      it('restart x10 on prepared → all rejected', async () => {
        mockConversationState.get.mockReturnValue(makeState('prepared'));

        for (let i = 0; i < 10; i++) {
          await expect(service.restart(testId)).rejects.toThrow(AppError);
        }
        expect(mockConversationState.transition).not.toHaveBeenCalledWith(testId, 'restarting');
      });

      it('delete x10 on running → first succeeds, rest safe no-op', async () => {
        mockConversationState.has
          .mockReturnValueOnce(true)
          .mockReturnValue(false);
        mockInstanceManager.destroyInstance.mockResolvedValue(undefined);

        let successCount = 0;
        for (let i = 0; i < 10; i++) {
          try {
            await service.delete(testId);
            successCount++;
          } catch (e: any) {
            expect(e.statusCode).toBe(404);
          }
        }
        expect(successCount).toBe(1);
        expect(mockInstanceManager.destroyInstance).toHaveBeenCalledTimes(1);
        expect(mockWorkspaceFactory.destroy).toHaveBeenCalledTimes(1);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'destroyed');
        expect(mockConversationState.remove).toHaveBeenCalledWith(testId);
      });

      it('delete x10 on prepared → first succeeds, rest safe no-op', async () => {
        mockConversationState.has
          .mockReturnValueOnce(true)
          .mockReturnValue(false);
        mockInstanceManager.destroyInstance.mockResolvedValue(undefined);

        let successCount = 0;
        for (let i = 0; i < 10; i++) {
          try {
            await service.delete(testId);
            successCount++;
          } catch (e: any) {
            expect(e.statusCode).toBe(404);
          }
        }
        expect(successCount).toBe(1);
        expect(mockWorkspaceFactory.destroy).toHaveBeenCalledTimes(1);
      });
    });

    // ── Part 2: 併發暴力測試 ─────────────────────────────────────
    describe('concurrent operations', () => {
      it('concurrent 10 start() on prepared → exactly 1 succeeds', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('prepared'))
          .mockReturnValue(makeState('running'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());

        const results = await Promise.allSettled(
          Array.from({ length: 10 }, () => service.start(testId))
        );

        const succeeded = results.filter(r => r.status === 'fulfilled');
        const rejected = results.filter(r => r.status === 'rejected');
        expect(succeeded).toHaveLength(1);
        expect(rejected).toHaveLength(9);
        expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(1);
      });

      it('concurrent 10 stop() on running → exactly 1 succeeds', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('running'))
          .mockReturnValue(makeState('stopped'));
        mockInstanceManager.destroyInstance.mockResolvedValue(undefined);

        const results = await Promise.allSettled(
          Array.from({ length: 10 }, () => service.stop(testId))
        );

        const succeeded = results.filter(r => r.status === 'fulfilled');
        expect(succeeded).toHaveLength(1);
        expect(mockInstanceManager.destroyInstance).toHaveBeenCalledTimes(1);
      });

      it('concurrent 10 restart() on running → all succeed (restart from running is valid)', async () => {
        mockConversationState.get
          .mockReturnValue(makeState('running'));
        mockInstanceManager.getInstance.mockReturnValue(makeInstance());
        mockInstanceManager.restartInstance.mockResolvedValue(undefined);

        const results = await Promise.allSettled(
          Array.from({ length: 10 }, () => service.restart(testId))
        );

        const succeeded = results.filter(r => r.status === 'fulfilled');
        expect(succeeded).toHaveLength(10);
        expect(mockInstanceManager.restartInstance).toHaveBeenCalledTimes(10);
      });

      it('concurrent 10 delete() on running → exactly 1 succeeds', async () => {
        mockConversationState.has
          .mockReturnValueOnce(true)
          .mockReturnValue(false);
        mockInstanceManager.destroyInstance.mockResolvedValue(undefined);

        const results = await Promise.allSettled(
          Array.from({ length: 10 }, () => service.delete(testId))
        );

        const succeeded = results.filter(r => r.status === 'fulfilled');
        expect(succeeded).toHaveLength(1);
        expect(mockInstanceManager.destroyInstance).toHaveBeenCalledTimes(1);
        expect(mockWorkspaceFactory.destroy).toHaveBeenCalledTimes(1);
      });

      it('concurrent start + delete → no crash, no orphan resources', async () => {
        mockConversationState.has.mockReturnValue(false);
        mockRuntimeManager.hasAgentType.mockReturnValue(true);
        mockConversationState.create.mockReturnValue(makeState('prepared'));
        await service.create(testId);

        mockConversationState.get.mockReturnValue(makeState('prepared'));
        mockConversationState.has.mockReturnValue(true);

        let resolveCreate: (v: unknown) => void;
        let instanceCreated = false;
        mockInstanceManager.createInstance.mockReturnValue(
          new Promise(resolve => {
            resolveCreate = (value: unknown) => {
              instanceCreated = true;
              resolve(value);
            };
          })
        );
        mockInstanceManager.destroyInstance.mockImplementation(async () => {
          expect(instanceCreated).toBe(true);
        });

        const startPromise = service.start(testId);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'starting');

        const deletePromise = service.delete(testId);
        expect(mockInstanceManager.destroyInstance).not.toHaveBeenCalled();

        resolveCreate!(makeInstance());
        const results = await Promise.allSettled([startPromise, deletePromise]);

        expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
        expect(mockInstanceManager.destroyInstance).toHaveBeenCalledTimes(1);
        expect(mockInstanceManager.deletePersistentData).toHaveBeenCalledWith(testId, 'opencode-direct');
        expect(mockWorkspaceFactory.destroy).toHaveBeenCalledWith(testId);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'destroyed');
        expect(mockConversationState.remove).toHaveBeenCalledWith(testId);
      });
    });

    // ── Part 3: 複雜序列組合測試 ─────────────────────────────────
    describe('sequence combinations', () => {
      it('start→stop→start→stop→delete: full lifecycle is repeatable', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('prepared'))
          .mockReturnValueOnce(makeState('running'))
          .mockReturnValueOnce(makeState('stopped'))
          .mockReturnValueOnce(makeState('running'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());
        mockInstanceManager.destroyInstance.mockResolvedValue(undefined);
        mockConversationState.has.mockReturnValue(true);

        await service.start(testId);
        await service.stop(testId);
        await service.start(testId);
        await service.stop(testId);
        await service.delete(testId);

        expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(2);
        expect(mockInstanceManager.destroyInstance).toHaveBeenCalledTimes(3);
        expect(mockWorkspaceFactory.destroy).toHaveBeenCalledTimes(1);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'destroyed');
      });

      it('start→stop→stop: double stop after start is safe', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('prepared'))
          .mockReturnValueOnce(makeState('running'))
          .mockReturnValue(makeState('stopped'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());
        mockInstanceManager.destroyInstance.mockResolvedValue(undefined);

        await service.start(testId);
        await service.stop(testId);
        await expect(service.stop(testId)).rejects.toThrow(AppError);
        expect(mockInstanceManager.destroyInstance).toHaveBeenCalledTimes(1);
      });

      it('start→restart→restart: double restart succeeds (running→running is valid)', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('prepared'))
          .mockReturnValueOnce(makeState('running'))
          .mockReturnValue(makeState('running'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());
        mockInstanceManager.getInstance.mockReturnValue(makeInstance());
        mockInstanceManager.restartInstance.mockResolvedValue(undefined);

        await service.start(testId);
        await service.restart(testId);
        await service.restart(testId);
        expect(mockInstanceManager.restartInstance).toHaveBeenCalledTimes(2);
        expect(mockConversationState.transition).toHaveBeenCalledTimes(6);
      });

      it('start→restart→stop: stop on restarting is rejected', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('prepared'))
          .mockReturnValueOnce(makeState('running'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());
        let restartInProgress = false;
        mockInstanceManager.restartInstance.mockImplementation(() => {
          restartInProgress = true;
          return new Promise(resolve => setTimeout(resolve, 10_000));
        });
        mockInstanceManager.getInstance
          .mockReturnValueOnce(makeState('running')) // for restart's hadInstance check
          .mockReturnValue(makeState('running')); // for the second restart call

        await service.start(testId);
        const restartPromise = service.restart(testId);
        await vi.waitFor(() => expect(restartInProgress).toBe(true));
        await expect(service.stop(testId)).rejects.toThrow(AppError);

        mockInstanceManager.restartInstance.mockResolvedValue(undefined);
        mockInstanceManager.getInstance.mockReturnValue(makeInstance());
        mockConversationState.get
          .mockReturnValueOnce(makeState('running'))
          .mockReturnValue(makeState('running'));
        await restartPromise;
      }, 15_000);

      it('start→stop→restart: restart from stopped works', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('prepared'))
          .mockReturnValueOnce(makeState('running'))
          .mockReturnValueOnce(makeState('stopped'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());
        mockInstanceManager.destroyInstance.mockResolvedValue(undefined);

        await service.start(testId);
        await service.stop(testId);

        mockConversationState.get.mockReturnValue(makeState('stopped'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());
        await service.restart(testId);
        expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(2);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'restarting');
      });

      it('start→restart→delete: can delete during restarting', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('prepared'))
          .mockReturnValueOnce(makeState('running'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());
        mockInstanceManager.getInstance.mockReturnValue(makeInstance());

        let resolveRestart: (v: unknown) => void;
        mockInstanceManager.restartInstance.mockReturnValue(new Promise(resolve => { resolveRestart = resolve; }));

        await service.start(testId);
        const restartPromise = service.restart(testId);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'restarting');

        mockConversationState.has.mockReturnValue(true);
        const deletePromise = service.delete(testId);

        resolveRestart!(undefined);
        await expect(restartPromise).resolves.toBeDefined();
        await expect(deletePromise).resolves.toBeUndefined();

        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'destroyed');
        expect(mockConversationState.remove).toHaveBeenCalledWith(testId);
      });

      it('prepared→delete→create→start→delete: full rebuild flow', async () => {
        mockConversationState.has.mockReturnValue(false);
        mockRuntimeManager.hasAgentType.mockReturnValue(true);
        mockConversationState.create.mockReturnValue(makeState('prepared'));
        await service.create(testId);

        mockConversationState.has.mockReturnValue(true);
        await service.delete(testId);

        mockConversationState.has.mockReturnValue(false);
        mockConversationState.create.mockReturnValue(makeState('prepared'));
        await service.create(testId);

        mockConversationState.get.mockReturnValue(makeState('prepared'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());
        await service.start(testId);

        mockConversationState.get.mockReturnValue(makeState('running'));
        mockConversationState.has.mockReturnValue(true);
        await service.delete(testId);

        expect(mockWorkspaceFactory.destroy).toHaveBeenCalledTimes(2);
        expect(mockWorkspaceFactory.create).toHaveBeenCalledTimes(2);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'destroyed');
      });

      it('error→start→stop→delete: recovery from error is fully usable', async () => {
        mockConversationState.get.mockReturnValue(makeState('error'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());

        await service.start(testId);

        mockConversationState.get.mockReturnValue(makeState('running'));
        mockInstanceManager.destroyInstance.mockResolvedValue(undefined);
        await service.stop(testId);

        mockConversationState.get.mockReturnValue(makeState('stopped'));
        mockConversationState.has.mockReturnValue(true);
        await service.delete(testId);

        expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(1);
        expect(mockInstanceManager.destroyInstance).toHaveBeenCalledTimes(2);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'destroyed');
      });

      it('error→stop: stop on error succeeds (error is allowed)', async () => {
        mockConversationState.get.mockReturnValue(makeState('error'));
        await service.stop(testId);
        expect(mockInstanceManager.destroyInstance).toHaveBeenCalledWith(testId);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'stopped');
      });

      it('running → onDestroyed (process crash) → stopped → recover via restart', async () => {
        mockConversationState.get.mockReturnValue(makeState('stopped'));
        mockInstanceManager.getInstance.mockReturnValue(undefined);
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());

        const result = await service.restart(testId);
        expect(result.status).toBe('running');
        expect(mockInstanceManager.createInstance).toHaveBeenCalledWith(testId, 'opencode-direct');
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'restarting');
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'running');
      });

      it('running → onDestroyed → stopped → recover via start', async () => {
        mockConversationState.get.mockReturnValue(makeState('stopped'));
        mockInstanceManager.getInstance.mockReturnValue(undefined);
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());

        const result = await service.start(testId);
        expect(result.status).toBe('running');
        expect(mockInstanceManager.createInstance).toHaveBeenCalledWith(testId, 'opencode-direct');
      });

      it('running → onDestroyed → stopped → delete works', async () => {
        mockConversationState.get.mockReturnValue(makeState('stopped'));
        mockConversationState.has.mockReturnValue(true);

        await service.delete(testId);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'destroyed');
        expect(mockConversationState.remove).toHaveBeenCalledWith(testId);
        expect(mockWorkspaceFactory.destroy).toHaveBeenCalledWith(testId);
      });

      it('running → onDestroyed → stopped → double stop rejected', async () => {
        mockConversationState.get.mockReturnValue(makeState('stopped'));

        await expect(service.stop(testId)).rejects.toThrow(AppError);
      });

      it('error→delete: delete on error succeeds', async () => {
        mockConversationState.has.mockReturnValue(true);
        await service.delete(testId);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'destroyed');
        expect(mockConversationState.remove).toHaveBeenCalledWith(testId);
      });

      it('start→stop→start→delete: repeatable lifecycle', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('prepared'))
          .mockReturnValueOnce(makeState('running'))
          .mockReturnValueOnce(makeState('stopped'))
          .mockReturnValueOnce(makeState('running'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());
        mockInstanceManager.destroyInstance.mockResolvedValue(undefined);
        mockConversationState.has.mockReturnValue(true);

        await service.start(testId);
        await service.stop(testId);
        await service.start(testId);
        await service.delete(testId);

        expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(2);
        expect(mockInstanceManager.destroyInstance).toHaveBeenCalledTimes(2);
        expect(mockConversationState.remove).toHaveBeenCalledWith(testId);
      });

      it('start→stop→start works after stop from running', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('prepared'))
          .mockReturnValueOnce(makeState('running'))
          .mockReturnValueOnce(makeState('stopped'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());
        mockInstanceManager.destroyInstance.mockResolvedValue(undefined);

        await service.start(testId);
        await service.stop(testId);

        mockConversationState.get.mockReturnValue(makeState('stopped'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance(41002));
        const result = await service.start(testId);
        expect(result.status).toBe('running');
        expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(2);
      });

      it('stop kills instance but still allows start from stopped', async () => {
        mockConversationState.get.mockReturnValue(makeState('running'));
        mockInstanceManager.destroyInstance.mockRejectedValue(new Error('kill failed'));

        await expect(service.stop(testId)).rejects.toThrow(AppError);
        expect(mockConversationState.transition).not.toHaveBeenCalledWith(testId, 'stopped');
      });
    });

    // ── Part 4: 競態條件 / 資源洩漏測試 ─────────────────────────
    describe('race conditions and resource leaks', () => {
      it('delete during start createInstance → no zombie, recoverable', async () => {
        mockConversationState.has.mockReturnValue(false);
        mockRuntimeManager.hasAgentType.mockReturnValue(true);
        mockConversationState.create.mockReturnValue(makeState('prepared'));
        await service.create(testId);

        mockConversationState.get.mockReturnValue(makeState('prepared'));
        mockConversationState.has.mockReturnValue(true);

        let resolveCreate: (v: unknown) => void;
        mockInstanceManager.createInstance.mockReturnValue(
          new Promise(resolve => { resolveCreate = resolve; })
        );

        const startPromise = service.start(testId);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'starting');

        const deletePromise = service.delete(testId);

        resolveCreate!(makeInstance());
        await expect(startPromise).resolves.toBeDefined();
        await expect(deletePromise).resolves.toBeUndefined();

        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'destroyed');
        expect(mockConversationState.remove).toHaveBeenCalledWith(testId);
        expect(mockWorkspaceFactory.destroy).toHaveBeenCalledWith(testId);

        mockConversationState.has.mockReturnValue(false);
        mockConversationState.create.mockReturnValue(makeState('prepared'));
        const recovered = await service.create('recovered');
        expect(recovered.status).toBe('prepared');
      });

      it('delete during restart fallback createInstance → no double zombie', async () => {
        mockConversationState.get.mockReturnValue(makeState('running'));
        mockInstanceManager.getInstance.mockReturnValue(makeInstance());
        mockInstanceManager.restartInstance.mockRejectedValue(new Error('restart failed'));

        let resolveCreate: (v: unknown) => void;
        mockInstanceManager.destroyInstance.mockResolvedValue(undefined);
        mockInstanceManager.createInstance.mockReturnValue(
          new Promise(resolve => { resolveCreate = resolve; })
        );

        const restartPromise = service.restart(testId);

        await vi.waitFor(() => {
          expect(mockInstanceManager.destroyInstance).toHaveBeenCalledWith(testId);
        });

        mockConversationState.has.mockReturnValue(true);
        const deletePromise = service.delete(testId);

        resolveCreate!(makeInstance());
        await expect(restartPromise).resolves.toBeDefined();
        await expect(deletePromise).resolves.toBeUndefined();

        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'destroyed');
        expect(mockConversationState.remove).toHaveBeenCalledWith(testId);
        expect(mockWorkspaceFactory.destroy).toHaveBeenCalledWith(testId);
      }, 15_000);

      it('delete during restartInstance → clean termination', async () => {
        mockConversationState.get.mockReturnValue(makeState('running'));
        mockInstanceManager.getInstance.mockReturnValue(makeInstance());

        let resolveRestart: (v: unknown) => void;
        mockInstanceManager.restartInstance.mockReturnValue(
          new Promise(resolve => { resolveRestart = resolve; })
        );

        const restartPromise = service.restart(testId);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'restarting');

        mockConversationState.has.mockReturnValue(true);
        const deletePromise = service.delete(testId);

        resolveRestart!(undefined);
        await expect(restartPromise).resolves.toBeDefined();
        await expect(deletePromise).resolves.toBeUndefined();

        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'destroyed');
        expect(mockConversationState.remove).toHaveBeenCalledWith(testId);
        expect(mockWorkspaceFactory.destroy).toHaveBeenCalledWith(testId);
      });

      it('stop during start createInstance → stops cleanly from starting', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('prepared'))
          .mockReturnValueOnce(makeState('starting'));
        mockInstanceManager.destroyInstance.mockResolvedValue(undefined);

        let resolveCreate: (v: unknown) => void;
        mockInstanceManager.createInstance.mockReturnValue(
          new Promise(resolve => { resolveCreate = resolve; })
        );

        const startPromise = service.start(testId);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'starting');

        const stopPromise = service.stop(testId);

        resolveCreate!(makeInstance());
        await expect(startPromise).resolves.toBeDefined();
        await expect(stopPromise).resolves.toBeUndefined();

        expect(mockInstanceManager.destroyInstance).toHaveBeenCalledWith(testId);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'stopped');
      });

      it('concurrent start + stop → consistent state', async () => {
        mockConversationState.has.mockReturnValue(false);
        mockRuntimeManager.hasAgentType.mockReturnValue(true);
        mockConversationState.create.mockReturnValue(makeState('prepared'));
        await service.create(testId);

        let resolveCreate: (v: unknown) => void;
        mockConversationState.get
          .mockReturnValueOnce(makeState('prepared'))
          .mockReturnValueOnce(makeState('starting'));
        mockInstanceManager.createInstance.mockReturnValue(new Promise(resolve => { resolveCreate = resolve; }));
        mockInstanceManager.destroyInstance.mockResolvedValue(undefined);

        const startPromise = service.start(testId);
        const stopPromise = service.stop(testId);

        resolveCreate!(makeInstance());
        await Promise.allSettled([startPromise, stopPromise]);

        expect(mockInstanceManager.createInstance).toHaveBeenCalledWith(testId, 'opencode-direct');
        expect(mockInstanceManager.destroyInstance).toHaveBeenCalledWith(testId);
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'starting');
        expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'stopped');
      });
    });

    describe('resource balance', () => {
      it('each createInstance is paired with exactly one destroyInstance', async () => {
        mockConversationState.get
          .mockReturnValueOnce(makeState('prepared'))
          .mockReturnValue(makeState('running'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance());

        await service.start(testId);

        mockConversationState.get.mockReturnValue(makeState('running'));
        mockInstanceManager.destroyInstance.mockResolvedValue(undefined);
        await service.stop(testId);

        expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(1);
        expect(mockInstanceManager.destroyInstance).toHaveBeenCalledTimes(1);

        mockConversationState.get.mockReturnValue(makeState('stopped'));
        mockInstanceManager.createInstance.mockResolvedValue(makeInstance(41002));
        await service.start(testId);

        mockConversationState.get.mockReturnValue(makeState('running'));
        mockConversationState.has.mockReturnValue(true);
        await service.delete(testId);

        expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(2);
        expect(mockInstanceManager.destroyInstance).toHaveBeenCalledTimes(2);
        expect(mockWorkspaceFactory.destroy).toHaveBeenCalledTimes(1);
      });
    });
  });
});
