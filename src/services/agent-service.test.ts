import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  existsSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock('../orchestrator/workspace-factory.js', () => ({
  WorkspaceFactory: class {
    getMaxSizeBytes() { return 50 * 1024 * 1024; }
  },
  getDirSize: vi.fn().mockReturnValue(0),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { AgentService } from './agent-service.js';

describe('AgentService', () => {
  let agentService: AgentService;
  let mockWorkspaceFactory: any;
  let mockConversationState: any;
  let mockInstanceManager: any;
  const testId = 'test-conv';
  const mockWsPath = '/tmp/workspace/test-conv';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('agent content');
    vi.mocked(readdirSync).mockReturnValue([]);

    mockWorkspaceFactory = {
      resolveWorkspacePath: vi.fn().mockReturnValue(mockWsPath),
      getMaxSizeBytes: vi.fn().mockReturnValue(50 * 1024 * 1024),
    };

    mockConversationState = {
      get: vi.fn().mockReturnValue({ status: 'prepared', ready: false }),
      markNeedsRestart: vi.fn(),
      emitEvent: vi.fn(),
    };

    mockInstanceManager = {
      getInstance: vi.fn(),
    };

    agentService = new AgentService(mockWorkspaceFactory, mockConversationState, mockInstanceManager);
  });

  function makeRunning(): void {
    mockConversationState.get.mockReturnValue({ status: 'running', ready: true });
  }

  describe('writeAgent', () => {
    it('should create agents dir and write agent file', () => {
      agentService.writeAgent(testId, 'my-agent', '# Agent content');

      const expectedDir = join(mockWsPath, '.opencode', 'agents');
      expect(mkdirSync).toHaveBeenCalledWith(expectedDir, { recursive: true });
      expect(writeFileSync).toHaveBeenCalledWith(
        join(expectedDir, 'my-agent.md'),
        '# Agent content',
        'utf-8'
      );
    });

    it('should sanitize agent name with slashes', () => {
      agentService.writeAgent(testId, 'my/agent', 'content');

      const agentsDir = join(mockWsPath, '.opencode', 'agents');
      expect(writeFileSync).toHaveBeenCalledWith(
        join(agentsDir, 'my_agent.md'),
        expect.any(String),
        'utf-8'
      );
    });

    it('should sanitize agent name with dots', () => {
      agentService.writeAgent(testId, 'my..agent', 'content');

      const agentsDir = join(mockWsPath, '.opencode', 'agents');
      expect(writeFileSync).toHaveBeenCalledWith(
        join(agentsDir, 'my_agent.md'),
        expect.any(String),
        'utf-8'
      );
    });

    it('should mark needsRestart and emit event when running', () => {
      makeRunning();

      agentService.writeAgent(testId, 'my-agent', 'content');

      expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith(testId, 'agent my-agent updated');
      expect(mockConversationState.emitEvent).toHaveBeenCalledWith(testId, 'conversation.configChanged', {
        changedFiles: ['.opencode/agents/my-agent.md'],
      });
    });

    it('should not mark needsRestart when not running', () => {
      agentService.writeAgent(testId, 'my-agent', 'content');

      expect(mockConversationState.markNeedsRestart).not.toHaveBeenCalled();
      expect(mockConversationState.emitEvent).toHaveBeenCalled();
    });
  });

  describe('readAgent', () => {
    it('should return agent content when file exists', () => {
      vi.mocked(readFileSync).mockReturnValueOnce('agent markdown content');

      const result = agentService.readAgent(testId, 'my-agent');

      expect(result).toBe('agent markdown content');
    });

    it('should throw when agent file does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      expect(() => agentService.readAgent(testId, 'missing-agent')).toThrow('Agent not found: missing-agent');
    });

    it('should sanitize the agent name when reading', () => {
      agentService.readAgent(testId, 'my/agent');

      const expectedPath = join(mockWsPath, '.opencode', 'agents', 'my_agent.md');
      expect(readFileSync).toHaveBeenCalledWith(expectedPath, 'utf-8');
    });
  });

  describe('deleteAgent', () => {
    it('should delete agent file and emit events', () => {
      agentService.deleteAgent(testId, 'my-agent');

      const expectedPath = join(mockWsPath, '.opencode', 'agents', 'my-agent.md');
      expect(rmSync).toHaveBeenCalledWith(expectedPath, { force: true });
      expect(mockConversationState.emitEvent).toHaveBeenCalledWith(testId, 'conversation.configChanged', {
        changedFiles: ['.opencode/agents/my-agent.md'],
      });
    });

    it('should not throw when agent file does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      expect(() => agentService.deleteAgent(testId, 'missing')).not.toThrow();
      expect(rmSync).not.toHaveBeenCalled();
    });

    it('should mark needsRestart when running', () => {
      makeRunning();

      agentService.deleteAgent(testId, 'my-agent');

      expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith(testId, 'agent my-agent deleted');
    });
  });

  describe('listAgents', () => {
    it('should return agent names from directory', () => {
      vi.mocked(readdirSync).mockReturnValue(['agent1.md', 'agent2.md', 'readme.txt'] as any);

      const result = agentService.listAgents(testId);

      expect(result).toEqual(['agent1', 'agent2']);
    });

    it('should return empty array when agents dir does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = agentService.listAgents(testId);

      expect(result).toEqual([]);
    });
  });

  describe('listAgentsWithRuntime', () => {
    it('should return plain names when conversation is not running', async () => {
      vi.mocked(readdirSync).mockReturnValue(['agent1.md', 'agent2.md'] as any);

      const result = await agentService.listAgentsWithRuntime(testId);

      expect(result).toEqual(['agent1', 'agent2']);
    });

    it('should enrich with descriptions when running and instance available', async () => {
      makeRunning();
      vi.mocked(readdirSync).mockReturnValue(['agent1.md', 'agent2.md'] as any);
      mockInstanceManager.getInstance.mockReturnValue({
        client: {
          listAgents: vi.fn().mockResolvedValue([
            { id: 'agent1', description: 'First agent' },
            { id: 'agent2' },
            { id: 'agent3', description: 'Extra' },
          ]),
        },
      });

      const result = await agentService.listAgentsWithRuntime(testId) as any[];

      expect(result).toEqual([
        { name: 'agent1', description: 'First agent' },
        { name: 'agent2' },
      ]);
    });

    it('should return plain names when running but instance not available', async () => {
      makeRunning();
      vi.mocked(readdirSync).mockReturnValue(['agent1.md'] as any);
      mockInstanceManager.getInstance.mockReturnValue(undefined);

      const result = await agentService.listAgentsWithRuntime(testId);

      expect(result).toEqual(['agent1']);
    });
  });

  describe('writeAgentsMd', () => {
    it('should write AGENTS.md file', () => {
      const content = '# AGENTS\n\n- agent1: does stuff';

      agentService.writeAgentsMd(testId, content);

      const expectedPath = join(mockWsPath, 'AGENTS.md');
      expect(writeFileSync).toHaveBeenCalledWith(expectedPath, content, 'utf-8');
    });

    it('should emit events', () => {
      agentService.writeAgentsMd(testId, 'content');

      expect(mockConversationState.emitEvent).toHaveBeenCalledWith(testId, 'conversation.configChanged', {
        changedFiles: ['AGENTS.md'],
      });
    });

    it('should mark needsRestart when running', () => {
      makeRunning();

      agentService.writeAgentsMd(testId, 'content');

      expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith(testId, 'AGENTS.md updated');
    });
  });

  describe('readAgentsMd', () => {
    it('should return AGENTS.md content', () => {
      vi.mocked(readFileSync).mockReturnValueOnce('# AGENTS content');

      const result = agentService.readAgentsMd(testId);

      expect(result).toBe('# AGENTS content');
    });

    it('should throw when AGENTS.md does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      expect(() => agentService.readAgentsMd(testId)).toThrow('AGENTS.md not found');
    });
  });

  describe('deleteAgentsMd', () => {
    it('should delete AGENTS.md and emit events', () => {
      agentService.deleteAgentsMd(testId);

      const expectedPath = join(mockWsPath, 'AGENTS.md');
      expect(rmSync).toHaveBeenCalledWith(expectedPath, { force: true });
      expect(mockConversationState.emitEvent).toHaveBeenCalledWith(testId, 'conversation.configChanged', {
        changedFiles: ['AGENTS.md'],
      });
    });

    it('should not throw when AGENTS.md does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      expect(() => agentService.deleteAgentsMd(testId)).not.toThrow();
      expect(rmSync).not.toHaveBeenCalled();
    });

    it('should mark needsRestart when running', () => {
      makeRunning();

      agentService.deleteAgentsMd(testId);

      expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith(testId, 'AGENTS.md deleted');
    });
  });
});
