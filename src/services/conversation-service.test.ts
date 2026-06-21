import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ConversationService } from './conversation-service.js';
import { AppError } from '../utils/errors.js';

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
      destroyInstance: vi.fn(),
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

    it('should start a prepared conversation', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState });
      mockInstanceManager.createInstance.mockResolvedValue({
        port: 41001,
        process: {},
        client: { createSession: vi.fn().mockResolvedValue({ id: 'ses_1' }) },
      });

      const result = await service.start(testId);

      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'starting');
      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'running');
      expect(result.status).toBe('running');
      expect(result.port).toBe(41001);
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

    it('should transition to error on instance creation failure', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState });
      mockInstanceManager.createInstance.mockRejectedValue(new Error('port busy'));

      await expect(service.start(testId)).rejects.toThrow(AppError);
      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'error', { error: 'port busy' });
    });
  });

  describe('stop', () => {
    it('should stop a running conversation', async () => {
      mockConversationState.get.mockReturnValue({ id: testId, status: 'running' });
      mockInstanceManager.destroyInstance.mockResolvedValue(undefined);

      await service.stop(testId);

      expect(mockInstanceManager.destroyInstance).toHaveBeenCalledWith(testId);
      expect(mockConversationState.removeRunningInstance).toHaveBeenCalledWith(testId);
      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'stopped');
    });

    it('should throw 404 when not found', async () => {
      mockConversationState.get.mockReturnValue(undefined);

      await expect(service.stop(testId)).rejects.toThrow(AppError);
    });

    it('should throw 409 when in prepared status', async () => {
      mockConversationState.get.mockReturnValue({ id: testId, status: 'prepared' });

      await expect(service.stop(testId)).rejects.toThrow(AppError);
      try { await service.stop(testId); } catch (e: any) {
        expect(e.statusCode).toBe(409);
      }
    });
  });

  describe('restart', () => {
    const mockState = {
      id: testId,
      agentType: 'opencode-direct',
      status: 'stopped',
      ready: false,
    };

    it('should restart a stopped conversation', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState });
      mockInstanceManager.createInstance.mockResolvedValue({
        port: 41002,
        process: {},
        client: { createSession: vi.fn().mockResolvedValue({ id: 'ses_2' }) },
      });

      const result = await service.restart(testId);

      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'restarting');
      expect(result.status).toBe('running');
    });

    it('should throw 404 when not found', async () => {
      mockConversationState.get.mockReturnValue(undefined);

      await expect(service.restart(testId)).rejects.toThrow(AppError);
    });

    it('should throw 409 when in prepared status', async () => {
      mockConversationState.get.mockReturnValue({ ...mockState, status: 'prepared' });

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

      expect(mockInstanceManager.restartInstance).toHaveBeenCalledWith(testId);
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

      expect(mockInstanceManager.restartInstance).toHaveBeenCalledWith(testId);
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

      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'restarting');
      expect(mockInstanceManager.getInstance).toHaveBeenCalledWith(testId);
      expect(mockInstanceManager.restartInstance).not.toHaveBeenCalled();
      expect(mockInstanceManager.createInstance).toHaveBeenCalledWith(testId, 'opencode-direct');
      expect(result.status).toBe('running');
    });
  });

  describe('delete', () => {
    it('should delete a conversation', async () => {
      mockConversationState.has.mockReturnValue(true);
      mockInstanceManager.destroyInstance.mockResolvedValue(undefined);

      await service.delete(testId);

      expect(mockInstanceManager.destroyInstance).toHaveBeenCalledWith(testId);
      expect(mockWorkspaceFactory.destroy).toHaveBeenCalledWith(testId);
      expect(mockConversationState.transition).toHaveBeenCalledWith(testId, 'destroyed');
      expect(mockConversationState.remove).toHaveBeenCalledWith(testId);
    });

    it('should swallow destroyInstance error', async () => {
      mockConversationState.has.mockReturnValue(true);
      mockInstanceManager.destroyInstance.mockRejectedValue(new Error('kill failed'));

      await service.delete(testId);

      expect(mockWorkspaceFactory.destroy).toHaveBeenCalledWith(testId);
    });

    it('should log warn on workspace destruction failure', async () => {
      const { logger } = await import('../utils/logger.js');
      mockConversationState.has.mockReturnValue(true);
      mockInstanceManager.destroyInstance.mockResolvedValue(undefined);
      mockWorkspaceFactory.destroy.mockImplementation(() => { throw new Error('permission denied'); });

      await service.delete(testId);

      expect(logger.warn).toHaveBeenCalled();
    });

    it('should throw 404 when not found', async () => {
      mockConversationState.has.mockReturnValue(false);

      await expect(service.delete(testId)).rejects.toThrow(AppError);
    });
  });
});
