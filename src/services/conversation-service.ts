import type { ServerConfig } from '../config-loader.js';
import { RuntimeRegistry } from '../agent-runtime/registry.js';
import { InstanceManager, type InstanceInfo } from '../orchestrator/instance-manager.js';
import { WorkspaceFactory } from '../orchestrator/workspace-factory.js';
import { ConversationState, type ConversationEvent } from '../orchestrator/conversation-state.js';
import type { AgentClient } from '../agent-runtime/types.js';
import { logger } from '../utils/logger.js';
import { AppError, ErrorCodes } from '../utils/errors.js';

export interface ConversationData {
  id: string;
  agentType: string;
  status: string;
  ready: boolean;
  needsRestart: boolean;
  port?: number;
  sessionId?: string;
  wsUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StartResult {
  id: string;
  agentType: string;
  status: string;
  ready: boolean;
  port: number;
  wsUrl?: string;
  sessionId?: string;
}

export class ConversationService {
  constructor(
    private instanceManager: InstanceManager,
    private conversationState: ConversationState,
    private workspaceFactory: WorkspaceFactory,
    private runtimeRegistry: RuntimeRegistry,
    private serverConfig: ServerConfig,
    private runtime: string
  ) {}

  create(id?: string, agentType?: string): ConversationData {
    const conversationId = id ?? this.generateId();

    if (this.conversationState.has(conversationId)) {
      throw new AppError(409, ErrorCodes.CONVERSATION_ALREADY_EXISTS, `Conversation already exists: ${conversationId}`);
    }

    const resolvedType = agentType ?? 'opencode';
    if (!this.runtimeRegistry.get(resolvedType)) {
      throw new AppError(400, ErrorCodes.UNKNOWN_AGENT_TYPE, `Unknown agent type: ${resolvedType}. Available: ${this.runtimeRegistry.list().join(', ')}`);
    }

    this.workspaceFactory.create(conversationId);

    const wsUrl = `ws://${this.serverConfig.host}:${this.serverConfig.port}/ws/${conversationId}`;
    const state = this.conversationState.create(conversationId, resolvedType, wsUrl);

    return this.toConversationData(state);
  }

  get(id: string): ConversationData {
    const state = this.conversationState.get(id);
    if (!state) {
      throw new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
    }
    return this.toConversationData(state);
  }

  list(): ConversationData[] {
    return this.conversationState.list().map((s) => this.toConversationData(s));
  }

  getEvents(id: string, limit = 50): ConversationEvent[] {
    if (!this.conversationState.has(id)) {
      throw new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
    }
    return this.conversationState.getRecentEvents(id, limit);
  }

  async start(id: string): Promise<StartResult> {
    const state = this.conversationState.get(id);
    if (!state) {
      throw new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
    }

    if (state.status === 'running' || state.status === 'starting') {
      throw new AppError(409, ErrorCodes.CONVERSATION_ALREADY_RUNNING, 'Conversation is already starting or running');
    }

    this.conversationState.cancelReadyCheck(id);
    this.conversationState.transition(id, 'starting');

    try {
      const instance = await this.instanceManager.createInstance(id, state.agentType);
      this.conversationState.setInstanceInfo(id, { port: instance.port });
      this.conversationState.setRunningInstance(id, {
        process: instance.process!,
        client: instance.client,
      });
      this.conversationState.transition(id, 'running');
      this.conversationState.startReadyCheck(id);

      this.createSessionInBackground(id, instance.client);

      return {
        id,
        agentType: state.agentType,
        status: 'running',
        ready: false,
        port: instance.port,
        wsUrl: state.wsUrl,
        sessionId: state.sessionId,
      };
    } catch (err) {
      this.conversationState.transition(id, 'error', { error: (err as Error).message });
      throw err instanceof AppError ? err : new AppError(500, ErrorCodes.INTERNAL_ERROR, (err as Error).message);
    }
  }

  async stop(id: string): Promise<void> {
    const state = this.conversationState.get(id);
    if (!state) {
      throw new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
    }

    if (state.status !== 'running' && state.status !== 'starting' && state.status !== 'error') {
      throw new AppError(409, ErrorCodes.CANNOT_STOP, `Cannot stop conversation in status: ${state.status}`);
    }

    try {
      await this.instanceManager.destroyInstance(id);
      this.conversationState.removeRunningInstance(id);
      this.conversationState.transition(id, 'stopped');
    } catch (err) {
      throw err instanceof AppError ? err : new AppError(500, ErrorCodes.INTERNAL_ERROR, (err as Error).message);
    }
  }

  async restart(id: string): Promise<StartResult> {
    const state = this.conversationState.get(id);
    if (!state) {
      throw new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
    }

    const previousStatus = state.status;
    if (previousStatus !== 'running' && previousStatus !== 'stopped' && previousStatus !== 'error') {
      throw new AppError(409, ErrorCodes.CANNOT_RESTART, `Cannot restart conversation in status: ${previousStatus}`);
    }

    this.conversationState.transition(id, 'restarting');

    try {
      const hadInstance = previousStatus === 'running' || previousStatus === 'error';
      let dockerRestarted = false;

      if (hadInstance) {
        this.conversationState.cancelReadyCheck(id);
        if (this.runtime === 'docker') {
          try {
            await this.instanceManager.restartInstance(id);
            dockerRestarted = true;
          } catch {
            await this.instanceManager.stopInstance(id).catch(() => {});
            this.conversationState.removeRunningInstance(id);
          }
        } else {
          await this.instanceManager.stopInstance(id);
          this.conversationState.removeRunningInstance(id);
        }
      }

      this.conversationState.clearNeedsRestart(id);

      let instance: InstanceInfo;
      if (dockerRestarted) {
        instance = this.instanceManager.getInstance(id)!;
      } else {
        instance = await this.instanceManager.createInstance(id, state.agentType);
        this.conversationState.setInstanceInfo(id, { port: instance.port });
        this.conversationState.setRunningInstance(id, {
          process: instance.process!,
          client: instance.client,
        });
      }

      this.conversationState.transition(id, 'running');
      this.conversationState.startReadyCheck(id);

      this.createSessionInBackground(id, instance.client);

      return {
        id,
        agentType: state.agentType,
        status: 'running',
        ready: false,
        port: instance.port,
        wsUrl: state.wsUrl,
        sessionId: state.sessionId,
      };
    } catch (err) {
      this.conversationState.transition(id, 'error', { error: (err as Error).message });
      throw err instanceof AppError ? err : new AppError(500, ErrorCodes.INTERNAL_ERROR, (err as Error).message);
    }
  }

  async delete(id: string): Promise<void> {
    if (!this.conversationState.has(id)) {
      throw new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
    }

    try {
      await this.instanceManager.destroyInstance(id).catch(() => {});
    } catch {
      // ignore
    }
    try {
      await this.workspaceFactory.destroy(id);
    } catch (wsErr) {
      logger.warn(`Failed to remove workspace for ${id}:`, wsErr);
    }
    this.conversationState.transition(id, 'destroyed');
    this.conversationState.remove(id);
  }

  private toConversationData(state: NonNullable<ReturnType<ConversationState['get']>>): ConversationData {
    return {
      id: state.id,
      agentType: state.agentType,
      status: state.status,
      ready: state.ready,
      needsRestart: state.needsRestart,
      port: state.port,
      sessionId: state.sessionId,
      wsUrl: state.wsUrl,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private createSessionInBackground(id: string, client: AgentClient): void {
    client.createSession({ title: `AgentOrchestrator-${id}` })
      .then((session) => {
        this.conversationState.setInstanceInfo(id, { sessionId: session.id });
        this.instanceManager.setSessionId(id, session.id);
        logger.info(`[OpenCode ${id}] session created: ${session.id}`);
      })
      .catch((err) => {
        logger.error(`[OpenCode ${id}] failed to create session: ${(err as Error).message}`);
      });
  }
}
