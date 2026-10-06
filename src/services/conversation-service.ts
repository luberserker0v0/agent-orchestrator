import type { ServerConfig } from '../config-loader.js';
import { RuntimeManager, type InstanceInfo } from '../agent-runtime/runtime-manager.js';
import { InstanceManager } from '../orchestrator/instance-manager.js';
import { WorkspaceFactory } from '../orchestrator/workspace-factory.js';
import { ConversationState, type ConversationEvent } from '../orchestrator/conversation-state.js';
import { SSEBridge } from '../orchestrator/sse-bridge.js';
import type { AgentClient } from '../agent-runtime/types.js';
import { logger } from '../utils/logger.js';
import { llmQuotaExhaustionsTotal } from '../metrics/registry.js';
import { AppError, ErrorCodes, isAppError } from '../utils/errors.js';
import { conversationVolumeClaimName, type K8sStatusReporter } from '../cluster/status-reporter.js';
import type { NodePlaceable } from '../agent-runtime/runtimes/kubernetes.js';
import { conversationIdRequirement, isValidConversationId } from '../utils/conversation-id.js';

export interface ConversationData {
  id: string;
  agentType: string;
  status: string;
  ready: boolean;
  needsRestart: boolean;
  port?: number;
  sessionId?: string;
  lastModel?: string;
  lastAgent?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StartResult {
  id: string;
  agentType: string;
  status: string;
  ready: boolean;
  port?: number;
  sessionId?: string;
}

export interface MigrateTarget {
  nodeName: string;
}

export interface MigrateResult extends StartResult {
  nodeName: string;
  resumed: boolean;
}

export class ConversationService {
  private readonly lifecycleTails = new Map<string, Promise<void>>();

  constructor(
    private instanceManager: InstanceManager,
    private conversationState: ConversationState,
    private workspaceFactory: WorkspaceFactory,
    private runtimeManager: RuntimeManager,
    private serverConfig: ServerConfig,
    private defaultAgentType: string,
    private sseBridge?: SSEBridge,
    private statusReporter?: K8sStatusReporter,
    private getRuntimeType?: (agentTypeId: string) => string | undefined,
  ) {}

  async create(id?: string, agentType?: string): Promise<ConversationData> {
    const conversationId = id ?? this.generateId();

    return this.runLifecycle(conversationId, () => this.createUnlocked(conversationId, agentType));
  }

  private async createUnlocked(conversationId: string, agentType?: string): Promise<ConversationData> {

    if (!isValidConversationId(conversationId)) {
      throw new AppError(
        400,
        ErrorCodes.INVALID_CONVERSATION_ID,
        `Invalid conversation id: ${conversationIdRequirement()}`,
      );
    }

    if (this.conversationState.has(conversationId)) {
      throw new AppError(409, ErrorCodes.CONVERSATION_ALREADY_EXISTS, `Conversation already exists: ${conversationId}`);
    }

    const resolvedType = agentType ?? this.defaultAgentType;
    if (!this.runtimeManager.hasAgentType(resolvedType)) {
      throw new AppError(400, ErrorCodes.UNKNOWN_AGENT_TYPE, `Unknown agent type: ${resolvedType}. Available: ${this.runtimeManager.listAgentTypes().join(', ')}`);
    }
    const validity = this.runtimeManager.getRuntimeValidity(resolvedType);
    if (validity && !validity.isValid) {
      throw new AppError(400, ErrorCodes.RUNTIME_NOT_AVAILABLE, `Runtime "${resolvedType}" is not available: ${validity.error}`);
    }

    await this.workspaceFactory.create(conversationId, resolvedType);

    const state = this.conversationState.create(conversationId, resolvedType);

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

  start(id: string): Promise<StartResult> {
    return this.runLifecycle(id, () => this.startUnlocked(id));
  }

  stop(id: string): Promise<void> {
    return this.runLifecycle(id, () => this.stopUnlocked(id));
  }

  restart(id: string): Promise<StartResult> {
    return this.runLifecycle(id, () => this.restartUnlocked(id));
  }

  migrateInstance(id: string, target: MigrateTarget): Promise<MigrateResult> {
    return this.runLifecycle(id, () => this.migrateInstanceUnlocked(id, target));
  }

  delete(id: string): Promise<void> {
    return this.runLifecycle(id, () => this.deleteUnlocked(id));
  }

  /** Share the lifecycle lock with retention cleanup final checks. */
  withLifecycleLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return this.runLifecycle(id, operation);
  }

  private async startUnlocked(id: string): Promise<StartResult> {
    const state = this.conversationState.get(id);
    if (!state) {
      throw new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
    }

    if (state.status === 'running' || state.status === 'starting' || state.status === 'restarting' || state.status === 'destroyed') {
      throw new AppError(409, ErrorCodes.CONVERSATION_ALREADY_RUNNING, 'Conversation is already starting or running');
    }

    this.conversationState.cancelReadyCheck(id);
    this.conversationState.transition(id, 'starting');

    try {
      const instance = await this.instanceManager.createInstance(id, state.agentType);
      this.conversationState.setInstanceInfo(id, { port: instance.port });
      this.conversationState.setRunningInstance(id, {
        client: instance.client,
      });
      this.conversationState.transition(id, 'running');
      this.conversationState.startReadyCheck(id);

      if (this.sseBridge && instance.baseUrl && instance.username && instance.password) {
        this.sseBridge.start(id, instance.baseUrl, instance.username, instance.password);
      }

      const runtimeType = this.getRuntimeType?.(state.agentType);
      await this.statusReporter?.trackInstance({
        conversationId: id,
        ...(runtimeType ? { runtimeType } : {}),
        ...(instance.baseUrl ? { endpoint: instance.baseUrl } : {}),
        ...(instance.nodeName ? { nodeName: instance.nodeName } : {}),
        ...(instance.persistentDataAnnotations
          ? { persistentDataAnnotations: instance.persistentDataAnnotations }
          : {}),
        volumeClaimName: conversationVolumeClaimName(id),
      });

      this.ensureSessionInBackground(id, instance.client);

      return {
        id,
        agentType: state.agentType,
        status: 'running',
        ready: false,
        port: instance.port,
        sessionId: state.sessionId,
      };
    } catch (err) {
      this.conversationState.transition(id, 'error', { error: (err as Error).message });
      throw err instanceof AppError ? err : new AppError(500, ErrorCodes.INTERNAL_ERROR, (err as Error).message);
    }
  }

  private async stopUnlocked(id: string): Promise<void> {
    const state = this.conversationState.get(id);
    if (!state) {
      throw new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
    }

    if (state.status !== 'running' && state.status !== 'starting' && state.status !== 'error') {
      throw new AppError(409, ErrorCodes.CANNOT_STOP, `Cannot stop conversation in status: ${state.status}`);
    }

    try {
      this.conversationState.cancelReadyCheck(id);
      this.sseBridge?.stop(id);
      await this.instanceManager.destroyInstance(id);
      this.conversationState.removeRunningInstance(id);
      this.conversationState.transition(id, 'stopped');
      await this.statusReporter?.reportStopped(id);
    } catch (err) {
      throw err instanceof AppError ? err : new AppError(500, ErrorCodes.INTERNAL_ERROR, (err as Error).message);
    }
  }

  private async restartUnlocked(id: string): Promise<StartResult> {
    const state = this.conversationState.get(id);
    if (!state) {
      throw new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
    }

    const previousStatus = state.status;
    if (previousStatus !== 'running' && previousStatus !== 'stopped' && previousStatus !== 'error') {
      throw new AppError(409, ErrorCodes.CANNOT_RESTART, `Cannot restart conversation in status: ${previousStatus}`);
    }

    this.conversationState.transition(id, 'restarting');

    this.sseBridge?.stop(id);

    try {
      const hadInstance = this.instanceManager.getInstance(id) !== undefined;

      let instance: InstanceInfo;
      if (hadInstance) {
        this.conversationState.cancelReadyCheck(id);
        try {
          await this.instanceManager.restartInstance(id, state.agentType);
          instance = this.instanceManager.getInstance(id)!;
        } catch {
          await this.instanceManager.destroyInstance(id).catch(() => {});
          this.conversationState.removeRunningInstance(id);
          instance = await this.instanceManager.createInstance(id, state.agentType);
        }
      } else {
        this.conversationState.cancelReadyCheck(id);
        instance = await this.instanceManager.createInstance(id, state.agentType);
      }

      this.conversationState.clearNeedsRestart(id);
      this.conversationState.setInstanceInfo(id, { port: instance.port });
      this.conversationState.setRunningInstance(id, { client: instance.client });
      this.conversationState.transition(id, 'running');
      this.conversationState.startReadyCheck(id);

      if (this.sseBridge && instance.baseUrl && instance.username && instance.password) {
        this.sseBridge.start(id, instance.baseUrl, instance.username, instance.password);
      }

      if (instance.baseUrl) {
        await this.statusReporter?.reportMoved(id, {
          endpoint: instance.baseUrl,
          ...(instance.nodeName ? { nodeName: instance.nodeName } : {}),
        });
      }

      this.ensureSessionInBackground(id, instance.client, state.sessionId);

      return {
        id,
        agentType: state.agentType,
        status: 'running',
        ready: false,
        port: instance.port,
        sessionId: state.sessionId,
      };
    } catch (err) {
      this.conversationState.transition(id, 'error', { error: (err as Error).message });
      throw err instanceof AppError ? err : new AppError(500, ErrorCodes.INTERNAL_ERROR, (err as Error).message);
    }
  }

  /**
   * Move a running conversation's instance to another node (quota-aware
   * placement). Requires a kubernetes runtime: the instance Pod is recreated
   * on the target node with the same PVC, and the previous session is resumed
   * (verified) or recreated. The node override is always cleared afterwards.
   */
  private async migrateInstanceUnlocked(id: string, target: MigrateTarget): Promise<MigrateResult> {
    const state = this.conversationState.get(id);
    if (!state) {
      throw new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
    }
    if (state.status !== 'running') {
      throw new AppError(409, ErrorCodes.CONVERSATION_NOT_RUNNING, `Conversation is not running (status: ${state.status})`);
    }
    if (!target || typeof target.nodeName !== 'string' || !target.nodeName) {
      throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Body must include a non-empty "nodeName"');
    }
    const runtime = this.runtimeManager.getRuntime(state.agentType);
    if (this.getRuntimeType?.(state.agentType) !== 'kubernetes' || !runtime || typeof (runtime as unknown as NodePlaceable).setNodeOverride !== 'function') {
      throw new AppError(400, ErrorCodes.MIGRATION_NOT_SUPPORTED, `Migration requires a kubernetes runtime (agent type: ${state.agentType})`);
    }
    const placeable = runtime as unknown as NodePlaceable;
    const previousSessionId = state.sessionId;

    this.conversationState.transition(id, 'restarting');
    this.conversationState.cancelReadyCheck(id);
    this.sseBridge?.stop(id);
    placeable.setNodeOverride(id, target.nodeName);
    try {
      const hadInstance = this.instanceManager.getInstance(id) !== undefined;

      let instance: InstanceInfo;
      if (hadInstance) {
        try {
          await this.instanceManager.restartInstance(id, state.agentType);
          instance = this.instanceManager.getInstance(id)!;
        } catch {
          await this.instanceManager.destroyInstance(id).catch(() => {});
          this.conversationState.removeRunningInstance(id);
          instance = await this.instanceManager.createInstance(id, state.agentType);
        }
      } else {
        instance = await this.instanceManager.createInstance(id, state.agentType);
      }

      this.conversationState.clearNeedsRestart(id);
      this.conversationState.setInstanceInfo(id, { port: instance.port });
      this.conversationState.setRunningInstance(id, { client: instance.client });
      this.conversationState.transition(id, 'running');
      this.conversationState.startReadyCheck(id);

      if (this.sseBridge && instance.baseUrl && instance.username && instance.password) {
        this.sseBridge.start(id, instance.baseUrl, instance.username, instance.password);
      }

      const { sessionId, resumed } = await this.resolveSession(id, instance.client, previousSessionId);
      this.conversationState.emitEvent(id, 'conversation.migrated', {
        nodeName: target.nodeName,
        resumed,
        sessionId,
      });
      if (instance.baseUrl) {
        await this.statusReporter?.reportMoved(id, {
          endpoint: instance.baseUrl,
          nodeName: instance.nodeName ?? target.nodeName,
        });
      }

      return {
        id,
        agentType: state.agentType,
        status: 'running',
        ready: false,
        port: instance.port,
        sessionId,
        nodeName: target.nodeName,
        resumed,
      };
    } catch (err) {
      this.conversationState.transition(id, 'error', { error: (err as Error).message });
      throw err instanceof AppError ? err : new AppError(500, ErrorCodes.INTERNAL_ERROR, (err as Error).message);
    } finally {
      placeable.clearNodeOverride(id);
    }
  }

  private async deleteUnlocked(id: string): Promise<void> {
    if (!this.conversationState.has(id)) {
      throw new AppError(404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
    }
    const agentType = this.conversationState.get(id)?.agentType;

    const hasInstance = this.instanceManager.getInstance(id) !== undefined;
    logger.info(`[${id}] delete: instance exists in manager=${hasInstance}`);
    try {
      await this.instanceManager.preparePersistentDataDeletion?.(id, agentType);
      if (agentType && this.getRuntimeType?.(agentType) === 'kubernetes') {
        await this.statusReporter?.markPersistentDataDeletePending(id);
      }
    } catch (err) {
      throw new AppError(
        500,
        ErrorCodes.PERSISTENT_DATA_CLEANUP_PENDING,
        `Unable to record persistent-data deletion intent for ${id}: ${(err as Error).message}`,
      );
    }
    try {
      await this.instanceManager.destroyInstance(id);
    } catch (err) {
      logger.warn(`Failed to stop runtime for ${id}; persistent data remains delete-pending`, err);
      throw new AppError(
        500,
        ErrorCodes.PERSISTENT_DATA_CLEANUP_PENDING,
        `Unable to stop runtime for ${id}; persistent data was not removed`,
      );
    }
    this.sseBridge?.stop(id);
    await this.instanceManager.deletePersistentData?.(id, agentType).catch((err: unknown) => {
      logger.warn(`Failed to remove persistent runtime data for ${id}:`, err);
    });
    logger.debug(`[${id}] delete: destroyInstance returned, attempting workspace cleanup`);
    try {
      await this.workspaceFactory.destroy(id);
      logger.info(`[${id}] delete: workspace cleanup completed`);
    } catch (wsErr) {
      logger.warn(`Failed to remove workspace for ${id}:`, wsErr);
      this.conversationState.transition(id, 'error', { error: (wsErr as Error).message });
      throw wsErr;
    }
    this.conversationState.transition(id, 'destroyed');
    this.conversationState.remove(id);
    await this.statusReporter?.untrackInstance(id);
  }

  /** Serialize lifecycle mutations for one conversation without blocking others. */
  private async runLifecycle<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = (previous ?? Promise.resolve()).then(() => gate);
    this.lifecycleTails.set(id, tail);

    if (previous) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.lifecycleTails.get(id) === tail) {
        this.lifecycleTails.delete(id);
      }
    }
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
      lastModel: state.lastModel,
      lastAgent: state.lastAgent,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Ensure the conversation has a live session on the (possibly new) instance.
   * When `resumeSessionId` is set and the server still knows it (e.g. restart
   * with persisted session storage), the existing session — and its full LLM
   * history — is adopted instead of discarded. Otherwise a fresh session is
   * created, preserving the previous behavior.
   */
  private ensureSessionInBackground(id: string, client: AgentClient, resumeSessionId?: string): void {
    this.resolveSession(id, client, resumeSessionId).then(
      ({ sessionId, resumed }) => {
        logger.info(`[OpenCode ${id}] session ${resumed ? 'resumed' : 'created'}: ${sessionId}`);
      },
      (err) => {
        logger.error(`[OpenCode ${id}] failed to ensure session: ${(err as Error).message}`);
        if (
          isAppError(err) &&
          (err.code === ErrorCodes.LLM_QUOTA_EXHAUSTED || err.code === ErrorCodes.LLM_RATE_LIMITED)
        ) {
          llmQuotaExhaustionsTotal.labels(err.code, '').inc();
          void this.statusReporter?.reportQuotaError(id, { code: err.code, message: err.message });
        }
      },
    );
  }

  private async resolveSession(
    id: string,
    client: AgentClient,
    resumeSessionId?: string,
  ): Promise<{ sessionId: string; resumed: boolean }> {
    if (resumeSessionId) {
      try {
        const session = await client.getSession(resumeSessionId);
        this.adoptSession(id, session.id);
        return { sessionId: session.id, resumed: true };
      } catch {
        logger.warn(`[OpenCode ${id}] previous session ${resumeSessionId} unavailable, creating fresh session`);
      }
    }
    const session = await client.createSession({ title: `AgentOrchestrator-${id}` });
    this.adoptSession(id, session.id);
    return { sessionId: session.id, resumed: false };
  }

  private adoptSession(id: string, sessionId: string): void {
    this.conversationState.setInstanceInfo(id, { sessionId });
    this.instanceManager.setSessionId(id, sessionId);
  }
}
