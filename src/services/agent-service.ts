import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { WorkspaceFactory, getDirSize } from '../orchestrator/workspace-factory.js';
import { ConversationState } from '../orchestrator/conversation-state.js';
import { InstanceManager } from '../orchestrator/instance-manager.js';
import { logger } from '../utils/logger.js';

export interface AgentItem {
  name: string;
  description?: string;
}

export class AgentService {
  constructor(
    private workspaceFactory: WorkspaceFactory,
    private conversationState: ConversationState,
    private instanceManager: InstanceManager
  ) {}

  writeAgent(id: string, name: string, content: string): void {
    const wsPath = this.workspaceFactory.resolveWorkspacePath(id);
    const agentsDir = join(wsPath, '.opencode', 'agents');
    const filePath = join(agentsDir, `${this.sanitize(name)}.md`);

    const size = Buffer.byteLength(content, 'utf-8');
    this.assertQuota(wsPath, size);

    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
    logger.info(`Agent written: ${filePath}`);

    this.markNeedsRestartIfRunning(id, `agent ${name} updated`);
    this.conversationState.emitEvent(id, 'conversation.configChanged', {
      changedFiles: [`.opencode/agents/${name}.md`],
    });
  }

  readAgent(id: string, name: string): string {
    const wsPath = this.workspaceFactory.resolveWorkspacePath(id);
    const filePath = join(wsPath, '.opencode', 'agents', `${this.sanitize(name)}.md`);
    if (!existsSync(filePath)) {
      throw new Error(`Agent not found: ${name}`);
    }
    return readFileSync(filePath, 'utf-8');
  }

  deleteAgent(id: string, name: string): void {
    const wsPath = this.workspaceFactory.resolveWorkspacePath(id);
    const filePath = join(wsPath, '.opencode', 'agents', `${this.sanitize(name)}.md`);
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
      logger.info(`Agent deleted: ${filePath}`);
    }

    this.markNeedsRestartIfRunning(id, `agent ${name} deleted`);
    this.conversationState.emitEvent(id, 'conversation.configChanged', {
      changedFiles: [`.opencode/agents/${name}.md`],
    });
  }

  listAgents(id: string): string[] {
    const wsPath = this.workspaceFactory.resolveWorkspacePath(id);
    const agentsDir = join(wsPath, '.opencode', 'agents');
    if (!existsSync(agentsDir)) return [];
    return readdirSync(agentsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => basename(f, '.md'));
  }

  async listAgentsWithRuntime(id: string): Promise<string[] | AgentItem[]> {
    const names = this.listAgents(id);

    const state = this.conversationState.get(id);
    if (state?.ready && state.status === 'running') {
      const instance = this.instanceManager.getInstance(id);
      if (instance) {
        const runtimeAgents = await instance.client.listAgents();
        const agentMap = new Map(runtimeAgents.map((a) => [a.id, a]));
        return names.map((name) => ({
          name,
          ...(agentMap.has(name) && agentMap.get(name)!.description
            ? { description: agentMap.get(name)!.description }
            : {}),
        }));
      }
    }

    return names;
  }

  writeAgentsMd(id: string, content: string): void {
    const wsPath = this.workspaceFactory.resolveWorkspacePath(id);
    const filePath = join(wsPath, 'AGENTS.md');

    const size = Buffer.byteLength(content, 'utf-8');
    this.assertQuota(wsPath, size);
    writeFileSync(filePath, content, 'utf-8');
    logger.info(`AGENTS.md written: ${filePath}`);

    this.markNeedsRestartIfRunning(id, 'AGENTS.md updated');
    this.conversationState.emitEvent(id, 'conversation.configChanged', {
      changedFiles: ['AGENTS.md'],
    });
  }

  readAgentsMd(id: string): string {
    const wsPath = this.workspaceFactory.resolveWorkspacePath(id);
    const filePath = join(wsPath, 'AGENTS.md');
    if (!existsSync(filePath)) {
      throw new Error('AGENTS.md not found');
    }
    return readFileSync(filePath, 'utf-8');
  }

  deleteAgentsMd(id: string): void {
    const wsPath = this.workspaceFactory.resolveWorkspacePath(id);
    const filePath = join(wsPath, 'AGENTS.md');
    if (existsSync(filePath)) {
      rmSync(filePath, { force: true });
      logger.info(`AGENTS.md deleted: ${filePath}`);
    }

    this.markNeedsRestartIfRunning(id, 'AGENTS.md deleted');
    this.conversationState.emitEvent(id, 'conversation.configChanged', {
      changedFiles: ['AGENTS.md'],
    });
  }

  private sanitize(raw: string): string {
    return raw.replace(/[\\/]/g, '_').replace(/\.{2,}/g, '_');
  }

  private assertQuota(wsPath: string, additionalBytes: number, excludingFile?: string): void {
    const currentSize = getDirSize(wsPath);
    let excluding = 0;
    if (excludingFile && existsSync(excludingFile)) {
      try {
        excluding = readFileSync(excludingFile).length;
      } catch {
        // ignore
      }
    }
    const MAX_WORKSPACE_SIZE = 50 * 1024 * 1024;
    if (currentSize - excluding + additionalBytes > MAX_WORKSPACE_SIZE) {
      throw new Error(
        `Workspace quota exceeded. Current: ${currentSize} bytes, Adding: ${additionalBytes} bytes, Limit: ${MAX_WORKSPACE_SIZE} bytes`
      );
    }
  }

  private markNeedsRestartIfRunning(id: string, reason: string): void {
    const state = this.conversationState.get(id);
    if (state && state.status === 'running') {
      this.conversationState.markNeedsRestart(id, reason);
    }
  }
}
