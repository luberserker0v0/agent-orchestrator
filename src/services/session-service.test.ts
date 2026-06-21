import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SessionService } from './session-service.js';
import { AppError } from '../utils/errors.js';

describe('SessionService', () => {
  let service: SessionService;
  let mockInstanceManager: any;
  let mockConversationState: any;
  let mockClient: any;
  const testId = 'conv-1';

  beforeEach(() => {
    mockClient = {
      createSession: vi.fn(),
      listSessions: vi.fn(),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
      forkSession: vi.fn(),
      getSessionChildren: vi.fn(),
      abortSession: vi.fn(),
      listProviders: vi.fn(),
    };

    mockInstanceManager = {
      getInstance: vi.fn(),
    };

    mockConversationState = {
      get: vi.fn(),
    };

    service = new SessionService(mockInstanceManager, mockConversationState);
  });

  function mockRunningReady(): void {
    mockConversationState.get.mockReturnValue({ status: 'running', ready: true });
    mockInstanceManager.getInstance.mockReturnValue({ client: mockClient, sessionId: 'ses_1' });
  }

  function mockNotRunning(): void {
    mockConversationState.get.mockReturnValue({ status: 'prepared', ready: false });
  }

  function mockNotReady(): void {
    mockConversationState.get.mockReturnValue({ status: 'running', ready: false });
    mockInstanceManager.getInstance.mockReturnValue({ client: mockClient, sessionId: 'ses_1' });
  }

  describe('create', () => {
    it('should create a session', async () => {
      mockRunningReady();
      mockClient.createSession.mockResolvedValue({ id: 'ses_new', title: 'test' });

      const result = await service.create(testId, { title: 'test' });

      expect(mockClient.createSession).toHaveBeenCalledWith({ title: 'test' });
      expect(result).toEqual({ id: 'ses_new', title: 'test' });
    });

    it('should throw 404 when conversation not found', async () => {
      mockConversationState.get.mockReturnValue(undefined);

      await expect(service.create(testId)).rejects.toThrow(AppError);
    });

    it('should throw 409 when not running', async () => {
      mockNotRunning();

      await expect(service.create(testId)).rejects.toThrow(AppError);
      try { await service.create(testId); } catch (e: any) { expect(e.statusCode).toBe(409); }
    });

    it('should throw 409 when not ready', async () => {
      mockNotReady();

      await expect(service.create(testId)).rejects.toThrow(AppError);
    });

    it('should throw 500 when instance reference lost', async () => {
      mockConversationState.get.mockReturnValue({ status: 'running', ready: true });
      mockInstanceManager.getInstance.mockReturnValue(undefined);

      await expect(service.create(testId)).rejects.toThrow(AppError);
      try { await service.create(testId); } catch (e: any) { expect(e.statusCode).toBe(500); }
    });
  });

  describe('list', () => {
    it('should list sessions', async () => {
      mockRunningReady();
      mockClient.listSessions.mockResolvedValue([{ id: 'ses_1' }]);

      const result = await service.list(testId);

      expect(result).toHaveLength(1);
    });
  });

  describe('get', () => {
    it('should get a session by id', async () => {
      mockRunningReady();
      mockClient.getSession.mockResolvedValue({ id: 'ses_1' });

      const result = await service.get(testId, 'ses_1');

      expect(result).toEqual({ id: 'ses_1' });
    });
  });

  describe('delete', () => {
    it('should delete a session', async () => {
      mockRunningReady();
      mockClient.deleteSession.mockResolvedValue(true);

      await service.delete(testId, 'ses_1');

      expect(mockClient.deleteSession).toHaveBeenCalledWith('ses_1');
    });
  });

  describe('fork', () => {
    it('should fork a session', async () => {
      mockRunningReady();
      mockClient.forkSession.mockResolvedValue({ id: 'ses_fork', parent_id: 'ses_1' });

      const result = await service.fork(testId, 'ses_1', 'msg_1') as any;

      expect(mockClient.forkSession).toHaveBeenCalledWith('ses_1', 'msg_1');
      expect(result.parent_id).toBe('ses_1');
    });
  });

  describe('getChildren', () => {
    it('should get session children', async () => {
      mockRunningReady();
      mockClient.getSessionChildren.mockResolvedValue([{ id: 'ses_child' }]);

      const result = await service.getChildren(testId, 'ses_1');

      expect(result).toHaveLength(1);
    });
  });

  describe('abort', () => {
    it('should abort current session', async () => {
      mockRunningReady();
      mockClient.abortSession.mockResolvedValue(true);

      const result = await service.abort(testId);

      expect(mockClient.abortSession).toHaveBeenCalledWith('ses_1');
      expect(result).toEqual({ aborted: true });
    });

    it('should throw 503 when no sessionId', async () => {
      mockRunningReady();
      mockInstanceManager.getInstance.mockReturnValue({ client: mockClient });

      await expect(service.abort(testId)).rejects.toThrow(AppError);
      try { await service.abort(testId); } catch (e: any) { expect(e.statusCode).toBe(503); }
    });
  });

  describe('listProviders', () => {
    it('should list providers', async () => {
      mockRunningReady();
      mockClient.listProviders.mockResolvedValue({ providers: [], default: {} });

      const result = await service.listProviders(testId);

      expect(result).toEqual({ providers: [], default: {} });
    });
  });

  describe('getClient', () => {
    it('should return client when instance exists', () => {
      mockInstanceManager.getInstance.mockReturnValue({ client: mockClient });

      const result = service.getClient(testId);

      expect(result).toBe(mockClient);
    });

    it('should return undefined when no instance', () => {
      mockInstanceManager.getInstance.mockReturnValue(undefined);

      const result = service.getClient(testId);

      expect(result).toBeUndefined();
    });
  });
});
