import { InstanceManager, type InstanceInfo } from '../orchestrator/instance-manager.js';
import { ConversationState } from '../orchestrator/conversation-state.js';
import type { AgentClient } from '../agent-runtime/types.js';
import type { ProviderListResult } from '../agent-runtime/types.js';
import { AppError, ErrorCodes } from '../utils/errors.js';

export class SessionService {
  constructor(
    private instanceManager: InstanceManager,
    private conversationState: ConversationState
  ) {}

  private ensureReady(id: string): InstanceInfo {
    const state = this.conversationState.get(id);
    if (!state) {
      throw new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
    }
    if (state.status !== 'running') {
      throw new AppError(409, ErrorCodes.CONVERSATION_NOT_RUNNING, `Conversation is not running (status: ${state.status})`);
    }
    if (!state.ready) {
      throw new AppError(409, ErrorCodes.INSTANCE_NOT_READY, 'Instance is not ready yet. OpenCode is still initializing.');
    }

    const instance = this.instanceManager.getInstance(id);
    if (!instance) {
      throw new AppError(500, ErrorCodes.INSTANCE_REFERENCE_LOST, 'Instance reference lost');
    }
    return instance;
  }

  async create(id: string, params?: { title?: string; parentID?: string }): Promise<unknown> {
    const instance = this.ensureReady(id);
    return instance.client.createSession(params ?? {});
  }

  async list(id: string): Promise<unknown[]> {
    const instance = this.ensureReady(id);
    return instance.client.listSessions();
  }

  async get(id: string, sessionId: string): Promise<unknown> {
    const instance = this.ensureReady(id);
    return instance.client.getSession(sessionId);
  }

  async delete(id: string, sessionId: string): Promise<void> {
    const instance = this.ensureReady(id);
    await instance.client.deleteSession(sessionId);
  }

  async fork(id: string, sessionId: string, messageID?: string): Promise<unknown> {
    const instance = this.ensureReady(id);
    return instance.client.forkSession(sessionId, messageID);
  }

  async getChildren(id: string, sessionId: string): Promise<unknown[]> {
    const instance = this.ensureReady(id);
    return instance.client.getSessionChildren(sessionId);
  }

  async abort(id: string): Promise<{ aborted: boolean }> {
    const instance = this.ensureReady(id);
    if (!instance.sessionId) {
      throw new AppError(503, ErrorCodes.SESSION_NOT_READY, 'Session not ready yet');
    }
    const result = await instance.client.abortSession(instance.sessionId);
    return { aborted: result };
  }

  async listProviders(id: string): Promise<ProviderListResult> {
    const instance = this.ensureReady(id);
    return instance.client.listProviders();
  }

  getClient(id: string): AgentClient | undefined {
    const instance = this.instanceManager.getInstance(id);
    return instance?.client;
  }
}
