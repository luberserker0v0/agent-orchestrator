import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../metrics/registry.js', () => {
  const inc = vi.fn();
  const observe = vi.fn();
  const labels = vi.fn().mockReturnValue({ inc });
  return {
    messagesSentTotal: { labels },
    messageSendDurationSeconds: { observe },
  };
});

import { MessageService } from './message-service.js';
import { AppError } from '../utils/errors.js';

describe('MessageService', () => {
  let service: MessageService;
  let mockInstanceManager: any;
  let mockConversationState: any;
  let mockClient: any;
  const testId = 'conv-1';

  beforeEach(() => {
    mockClient = {
      sendPrompt: vi.fn(),
      listMessages: vi.fn(),
    };

    mockInstanceManager = {
      getInstance: vi.fn(),
    };

    mockConversationState = {
      get: vi.fn(),
      emitEvent: vi.fn(),
    };

    service = new MessageService(mockInstanceManager, mockConversationState);
  });

  function mockReady(sessionId?: string): void {
    mockConversationState.get.mockReturnValue({ status: 'running', ready: true });
    mockInstanceManager.getInstance.mockReturnValue({ client: mockClient, sessionId });
  }

  describe('send', () => {
    it('should send a message and return result', async () => {
      mockReady('ses_1');
      mockClient.sendPrompt.mockResolvedValue({
        info: { id: 'msg_1' },
        parts: [{ type: 'text', text: 'Hello!' }],
      });

      const result = await service.send(testId, 'Hi there');

      expect(mockClient.sendPrompt).toHaveBeenCalled();
      expect(result.messageId).toBe('msg_1');
      expect(result.text).toBe('Hello!');
      expect(result.parts).toHaveLength(1);
    });

    it('should emit conversation.message event', async () => {
      mockReady('ses_1');
      mockClient.sendPrompt.mockResolvedValue({
        info: { id: 'msg_1' },
        parts: [{ type: 'text', text: 'Reply' }],
      });

      await service.send(testId, 'Hi');

      expect(mockConversationState.emitEvent).toHaveBeenCalledWith(testId, 'conversation.message', {
        messageId: 'msg_1',
        text: 'Reply',
        parts: [{ type: 'text', text: 'Reply' }],
        role: 'assistant',
      });
    });

    it('should throw 404 when conversation not found', async () => {
      mockConversationState.get.mockReturnValue(undefined);

      await expect(service.send(testId, 'Hi')).rejects.toThrow(AppError);
      try { await service.send(testId, 'Hi'); } catch (e: any) { expect(e.statusCode).toBe(404); }
    });

    it('should throw 409 when not running', async () => {
      mockConversationState.get.mockReturnValue({ status: 'prepared', ready: false });

      await expect(service.send(testId, 'Hi')).rejects.toThrow(AppError);
      try { await service.send(testId, 'Hi'); } catch (e: any) { expect(e.statusCode).toBe(409); }
    });

    it('should throw 409 when not ready', async () => {
      mockConversationState.get.mockReturnValue({ status: 'running', ready: false });
      mockInstanceManager.getInstance.mockReturnValue({ client: mockClient });

      await expect(service.send(testId, 'Hi')).rejects.toThrow(AppError);
      try { await service.send(testId, 'Hi'); } catch (e: any) { expect(e.statusCode).toBe(409); }
    });

    it('should throw 500 when instance reference lost', async () => {
      mockConversationState.get.mockReturnValue({ status: 'running', ready: true });
      mockInstanceManager.getInstance.mockReturnValue(undefined);

      await expect(service.send(testId, 'Hi')).rejects.toThrow(AppError);
      try { await service.send(testId, 'Hi'); } catch (e: any) { expect(e.statusCode).toBe(500); }
    });

    it('should throw 503 when session not ready', async () => {
      mockReady();

      await expect(service.send(testId, 'Hi')).rejects.toThrow(AppError);
      try { await service.send(testId, 'Hi'); } catch (e: any) { expect(e.statusCode).toBe(503); }
    });

    it('should parse model string from rawModel', async () => {
      mockReady('ses_1');
      mockClient.sendPrompt.mockResolvedValue({
        info: { id: 'msg_1' },
        parts: [{ type: 'text', text: 'ok' }],
      });

      await service.send(testId, 'Hi', 'anthropic/claude-3');

      const callArgs = mockClient.sendPrompt.mock.calls[0][1];
      expect(callArgs.model).toEqual({ providerID: 'anthropic', modelID: 'claude-3' });
    });

    it('should pass agent when provided', async () => {
      mockReady('ses_1');
      mockClient.sendPrompt.mockResolvedValue({
        info: { id: 'msg_1' },
        parts: [{ type: 'text', text: 'ok' }],
      });

      await service.send(testId, 'Hi', undefined, 'designer');

      const callArgs = mockClient.sendPrompt.mock.calls[0][1];
      expect(callArgs.agent).toBe('designer');
    });

    it('should increment messages_sent_total on success', async () => {
      const { messagesSentTotal, messageSendDurationSeconds } = await import('../metrics/registry.js');
      mockReady('ses_1');
      mockClient.sendPrompt.mockResolvedValue({
        info: { id: 'msg_1' },
        parts: [{ type: 'text', text: 'ok' }],
      });

      await service.send(testId, 'Hi');

      expect(messagesSentTotal.labels).toHaveBeenCalledWith('success');
      expect(messagesSentTotal.labels('success').inc).toHaveBeenCalled();
      expect(messageSendDurationSeconds.observe).toHaveBeenCalled();
    });

    it('should increment messages_sent_total on error', async () => {
      const { messagesSentTotal, messageSendDurationSeconds } = await import('../metrics/registry.js');
      mockReady('ses_1');
      mockClient.sendPrompt.mockRejectedValue(new Error('send failed'));

      await expect(service.send(testId, 'Hi')).rejects.toThrow('send failed');

      expect(messagesSentTotal.labels).toHaveBeenCalledWith('error');
      expect(messagesSentTotal.labels('error').inc).toHaveBeenCalled();
      expect(messageSendDurationSeconds.observe).toHaveBeenCalled();
    });
  });

  describe('getHistory', () => {
    it('should return message history', async () => {
      mockReady('ses_1');
      mockClient.listMessages.mockResolvedValue([
        { info: { id: 'msg_1' }, parts: [] },
      ]);

      const result = await service.getHistory(testId);

      expect(result).toHaveLength(1);
    });

    it('should use provided sessionId', async () => {
      mockReady('ses_1');
      mockClient.listMessages.mockResolvedValue([]);

      await service.getHistory(testId, 'ses_alt');

      expect(mockClient.listMessages).toHaveBeenCalledWith('ses_alt', undefined);
    });

    it('should throw 503 when no sessionId available', async () => {
      mockReady();

      await expect(service.getHistory(testId)).rejects.toThrow(AppError);
      try { await service.getHistory(testId); } catch (e: any) { expect(e.statusCode).toBe(503); }
    });
  });
});
