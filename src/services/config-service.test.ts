import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConfigService } from './config-service.js';
import type { OpencodeConfig } from '../opencode-http/types.js';

describe('ConfigService', () => {
  let configService: ConfigService;
  let mockWorkspaceFactory: any;
  let mockConversationState: any;
  const testId = 'test-conv';
  const sampleConfig: OpencodeConfig = {
    model: 'anthropic/claude-sonnet-4',
    provider: {
      anthropic: { name: 'anthropic', models: {} },
    },
  };

  beforeEach(() => {
    mockWorkspaceFactory = {
      readConfig: vi.fn().mockReturnValue({ ...sampleConfig }),
      writeConfig: vi.fn(),
    };
    mockConversationState = {
      get: vi.fn(),
      markNeedsRestart: vi.fn(),
      emitEvent: vi.fn(),
    };
    configService = new ConfigService(mockWorkspaceFactory, mockConversationState);
  });

  describe('readConfig', () => {
    it('should delegate to workspaceFactory.readConfig', () => {
      const result = configService.readConfig(testId);
      expect(mockWorkspaceFactory.readConfig).toHaveBeenCalledWith(testId);
      expect(result).toEqual(sampleConfig);
    });
  });

  describe('writeConfig', () => {
    it('should write config through workspaceFactory', () => {
      configService.writeConfig(testId, sampleConfig);
      expect(mockWorkspaceFactory.writeConfig).toHaveBeenCalledWith(testId, sampleConfig);
    });

    it('should mark needsRestart and emit event when conversation is running', () => {
      mockConversationState.get.mockReturnValue({ status: 'running' });

      configService.writeConfig(testId, sampleConfig);

      expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith(testId, 'opencode.json changed');
      expect(mockConversationState.emitEvent).toHaveBeenCalledWith(testId, 'conversation.configChanged', {
        changedFiles: ['.opencode/opencode.json'],
      });
    });

    it('should not mark needsRestart when conversation is not running', () => {
      mockConversationState.get.mockReturnValue({ status: 'prepared' });

      configService.writeConfig(testId, sampleConfig);

      expect(mockConversationState.markNeedsRestart).not.toHaveBeenCalled();
      expect(mockConversationState.emitEvent).toHaveBeenCalled();
    });

    it('should not mark needsRestart when conversation does not exist', () => {
      mockConversationState.get.mockReturnValue(undefined);

      configService.writeConfig(testId, sampleConfig);

      expect(mockConversationState.markNeedsRestart).not.toHaveBeenCalled();
      expect(mockConversationState.emitEvent).toHaveBeenCalled();
    });
  });

  describe('patchConfig', () => {
    it('should deep merge patch with current config and write', () => {
      const patch = { model: 'openai/gpt-4' };

      configService.patchConfig(testId, patch);

      expect(mockWorkspaceFactory.readConfig).toHaveBeenCalledWith(testId);
      const written = mockWorkspaceFactory.writeConfig.mock.calls[0][1] as OpencodeConfig;
      expect(written.model).toBe('openai/gpt-4');
      expect(written.provider).toEqual(sampleConfig.provider);
    });

    it('should deep merge nested objects', () => {
      const patch = {
        provider: {
          anthropic: { name: 'anthropic', options: { baseURL: 'https://custom.com' } },
        },
      };

      configService.patchConfig(testId, patch);

      const written = mockWorkspaceFactory.writeConfig.mock.calls[0][1] as Record<string, unknown>;
      const provider = written.provider as Record<string, unknown>;
      const anthropic = provider.anthropic as Record<string, unknown>;
      expect(anthropic.name).toBe('anthropic');
      expect((anthropic.options as Record<string, unknown>).baseURL).toBe('https://custom.com');
      expect((anthropic as Record<string, unknown>).models).toEqual({});
    });

    it('should replace arrays instead of merging', () => {
      mockWorkspaceFactory.readConfig.mockReturnValue({ model: 'a/b', tags: ['old'] });
      const patch = { tags: ['new'] };

      configService.patchConfig(testId, patch);

      const written = mockWorkspaceFactory.writeConfig.mock.calls[0][1] as Record<string, unknown>;
      expect(written.tags).toEqual(['new']);
    });

    it('should set new top-level keys', () => {
      const patch = { customKey: 'customValue' };

      configService.patchConfig(testId, patch);

      const written = mockWorkspaceFactory.writeConfig.mock.calls[0][1] as Record<string, unknown>;
      expect(written.customKey).toBe('customValue');
    });

    it('should mark needsRestart and emit event', () => {
      mockConversationState.get.mockReturnValue({ status: 'running' });
      const patch = { model: 'o3-mini' };

      configService.patchConfig(testId, patch);

      expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith(testId, 'opencode.json changed');
      expect(mockConversationState.emitEvent).toHaveBeenCalledWith(testId, 'conversation.configChanged', {
        changedFiles: ['.opencode/opencode.json'],
      });
    });

    it('should not mark needsRestart when not running', () => {
      mockConversationState.get.mockReturnValue(undefined);
      const patch = { model: 'o3-mini' };

      configService.patchConfig(testId, patch);

      expect(mockConversationState.markNeedsRestart).not.toHaveBeenCalled();
    });
  });
});
