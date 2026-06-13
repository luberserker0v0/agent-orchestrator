import { ConversationState } from '../orchestrator/conversation-state.js';
import { WorkspaceFactory } from '../orchestrator/workspace-factory.js';
import type { OpencodeConfig } from '../opencode-http/types.js';

export class ConfigService {
  constructor(
    private workspaceFactory: WorkspaceFactory,
    private conversationState: ConversationState
  ) {}

  readConfig(id: string): OpencodeConfig {
    return this.workspaceFactory.readConfig(id);
  }

  writeConfig(id: string, config: OpencodeConfig): void {
    this.workspaceFactory.writeConfig(id, config);
    this.markNeedsRestartIfRunning(id, 'opencode.json changed');
    this.conversationState.emitEvent(id, 'conversation.configChanged', {
      changedFiles: ['.opencode/opencode.json'],
    });
  }

  patchConfig(id: string, patch: Record<string, unknown>): void {
    const current = this.workspaceFactory.readConfig(id);
    const merged = this.deepMerge(current as unknown as Record<string, unknown>, patch);
    this.workspaceFactory.writeConfig(id, merged as unknown as OpencodeConfig);
    this.markNeedsRestartIfRunning(id, 'opencode.json changed');
    this.conversationState.emitEvent(id, 'conversation.configChanged', {
      changedFiles: ['.opencode/opencode.json'],
    });
  }

  private deepMerge(
    target: Record<string, unknown>,
    source: Record<string, unknown>
  ): Record<string, unknown> {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (
        source[key] !== null &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        target[key] !== null &&
        typeof target[key] === 'object' &&
        !Array.isArray(target[key])
      ) {
        result[key] = this.deepMerge(
          target[key] as Record<string, unknown>,
          source[key] as Record<string, unknown>
        );
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }

  private markNeedsRestartIfRunning(id: string, reason: string): void {
    const state = this.conversationState.get(id);
    if (state && state.status === 'running') {
      this.conversationState.markNeedsRestart(id, reason);
    }
  }
}
