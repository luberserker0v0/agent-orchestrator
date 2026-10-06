import { validateAgentName, validateSkillName } from '../orchestrator/workspace-factory.js';
import type { ConversationState } from '../orchestrator/conversation-state.js';
import type { AgentService } from '../services/agent-service.js';
import type { ConfigService } from '../services/config-service.js';
import type { ConversationService } from '../services/conversation-service.js';
import type { FileService } from '../services/file-service.js';
import type { MessageService } from '../services/message-service.js';
import type { SessionService } from '../services/session-service.js';
import type { SkillService } from '../services/skill-service.js';
import { AppError, ErrorCodes } from '../utils/errors.js';

export interface WSMethodDependencies {
  conversationState: ConversationState;
  configService: ConfigService;
  agentService: AgentService;
  skillService: SkillService;
  conversationService: ConversationService;
  fileService: FileService;
  sessionService: SessionService;
  messageService: MessageService;
}

/** Dispatches authenticated WebSocket RPC calls to cohesive service groups. */
export class WSMethodDispatcher {
  constructor(private readonly services: WSMethodDependencies) {}

  dispatch(conversationId: string, method: string, params: unknown): Promise<unknown> | unknown {
    if (method.startsWith('message.')) return this.dispatchMessage(conversationId, method, params);
    if (method.startsWith('config.')) return this.dispatchConfig(conversationId, method, params);
    if (method.startsWith('agent.')) return this.dispatchAgent(conversationId, method, params);
    if (method.startsWith('file.')) return this.dispatchFile(conversationId, method, params);
    if (method.startsWith('session.') || method === 'providers.list') {
      return this.dispatchSession(conversationId, method, params);
    }
    if (method.startsWith('skills.')) return this.dispatchSkill(conversationId, method, params);
    if (method.startsWith('conversation.')) return this.dispatchConversation(conversationId, method);
    throw new AppError(400, ErrorCodes.INTERNAL_ERROR, `Unknown method: ${method}`);
  }

  private dispatchMessage(conversationId: string, method: string, params: unknown): Promise<unknown> {
    if (method === 'message.send') {
      const { text, model, agent } = params as { text: string; model?: string; agent?: string };
      if (!text) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Missing text parameter');
      return this.services.messageService.send(conversationId, text, model, agent);
    }
    if (method === 'message.history') {
      const { sessionId, limit } = params as { sessionId?: string; limit?: number };
      return this.services.messageService.getHistory(conversationId, sessionId, limit);
    }
    return this.unknown(method);
  }

  private dispatchConfig(conversationId: string, method: string, params: unknown): unknown {
    if (method === 'config.get') return this.services.configService.readConfig(conversationId);
    const { config } = params as { config: Record<string, unknown> };
    if (typeof config !== 'object' || config === null) {
      const suffix = method === 'config.patch' ? ' patch' : '';
      throw new AppError(400, ErrorCodes.INVALID_REQUEST_BODY, `Missing or invalid config${suffix}`);
    }
    if (method === 'config.update') {
      this.services.configService.writeConfig(conversationId, config);
      return { updated: true };
    }
    if (method === 'config.patch') {
      this.services.configService.patchConfig(conversationId, config);
      return { updated: true };
    }
    return this.unknown(method);
  }

  private dispatchAgent(conversationId: string, method: string, params: unknown): Promise<unknown> | unknown {
    if (method === 'agent.list') return this.services.agentService.listAgentsWithRuntime(conversationId);
    if (method === 'agent.register') {
      const { name, content } = params as { name: string; content: string };
      if (!name || content === undefined) this.missing('Missing name or content');
      this.services.agentService.writeAgent(conversationId, name, content);
      return { registered: name };
    }
    if (method === 'agent.get' || method === 'agent.delete') {
      const { name } = params as { name: string };
      if (!name) this.missing('Missing name');
      if (method === 'agent.get') return this.services.agentService.readAgent(conversationId, name);
      this.services.agentService.deleteAgent(conversationId, name);
      return { deleted: name };
    }
    if (method === 'agent.config.get') return this.services.agentService.readAgentsMd(conversationId);
    if (method === 'agent.config.write') {
      const { content } = params as { content: string };
      if (content === undefined) this.missing('Missing content');
      this.services.agentService.writeAgentsMd(conversationId, content);
      return { written: true };
    }
    if (method === 'agent.config.delete') {
      this.services.agentService.deleteAgentsMd(conversationId);
      return { deleted: true };
    }
    return this.unknown(method);
  }

  private dispatchFile(conversationId: string, method: string, params: unknown): unknown {
    if (method === 'file.list') {
      const { path } = params as { path?: string };
      return this.services.fileService.list(conversationId, path);
    }
    if (method === 'file.copy') {
      const { source, dest } = params as { source: string; dest: string };
      if (!source || !dest) this.missing('Missing source or dest');
      this.services.fileService.copy(conversationId, source, dest);
      return { copied: dest };
    }
    const { path, content } = params as { path?: string; content?: string };
    if (path === undefined) this.missing(method === 'file.write' ? 'Missing path or content' : 'Missing path');
    if (method === 'file.write') {
      if (content === undefined) this.missing('Missing path or content');
      this.services.fileService.write(conversationId, path, content);
      return { written: path };
    }
    if (method === 'file.read') return this.services.fileService.read(conversationId, path);
    if (method === 'file.delete') {
      this.services.fileService.delete(conversationId, path);
      return { deleted: path };
    }
    return this.unknown(method);
  }

  private dispatchSession(conversationId: string, method: string, params: unknown): Promise<unknown> {
    if (method === 'session.create') {
      return this.services.sessionService.create(
        conversationId,
        params as { title?: string; parentID?: string } | undefined,
      );
    }
    if (method === 'session.list') return this.services.sessionService.list(conversationId);
    if (method === 'session.abort') return this.services.sessionService.abort(conversationId);
    if (method === 'providers.list') return this.services.sessionService.listProviders(conversationId);
    const { sessionId, messageID } = params as { sessionId: string; messageID?: string };
    if (!sessionId) this.missing('Missing sessionId');
    if (method === 'session.get') return this.services.sessionService.get(conversationId, sessionId);
    if (method === 'session.children') return this.services.sessionService.getChildren(conversationId, sessionId);
    if (method === 'session.fork') return this.services.sessionService.fork(conversationId, sessionId, messageID);
    if (method === 'session.delete') {
      return this.services.sessionService.delete(conversationId, sessionId).then(() => ({ deleted: sessionId }));
    }
    return Promise.reject(this.unknownError(method));
  }

  private dispatchSkill(conversationId: string, method: string, params: unknown): unknown {
    const { source, name, agent } = params as { source?: string; name?: string; agent?: string };
    const agentName = this.optionalAgentName(agent);
    if (method === 'skills.list') return this.services.skillService.listSkills(conversationId, agentName);
    if (method === 'skills.import') {
      if (!source || !name) this.missing('Missing source or name');
      this.services.skillService.importSkill(conversationId, source, name, agentName);
      return { imported: name };
    }
    if (!name) this.missing('Missing name');
    this.assertSkillName(name);
    if (method === 'skills.get') return this.services.skillService.readSkill(conversationId, name, agentName);
    if (method === 'skills.info') return this.services.skillService.getSkillInfo(conversationId, name, agentName);
    if (method === 'skills.delete') {
      this.services.skillService.deleteSkill(conversationId, name, agentName);
      return { deleted: name };
    }
    return this.unknown(method);
  }

  private async dispatchConversation(conversationId: string, method: string): Promise<unknown> {
    if (method === 'conversation.status') {
      return {
        ...this.services.conversationService.get(conversationId),
        lastError: this.services.conversationState.get(conversationId)?.lastError,
      };
    }
    if (method === 'conversation.start') return this.services.conversationService.start(conversationId);
    if (method === 'conversation.restart') return this.services.conversationService.restart(conversationId);
    if (method === 'conversation.stop') {
      await this.services.conversationService.stop(conversationId);
      return { status: 'stopped' };
    }
    if (method === 'conversation.delete') {
      await this.services.conversationService.delete(conversationId);
      return { deleted: true };
    }
    return this.unknown(method);
  }

  private optionalAgentName(agent?: string): string | undefined {
    if (!agent) return undefined;
    try {
      return validateAgentName(agent);
    } catch {
      throw new AppError(400, ErrorCodes.INVALID_AGENT_NAME, 'Invalid agent name');
    }
  }

  private assertSkillName(name: string): void {
    try {
      validateSkillName(name);
    } catch {
      throw new AppError(400, ErrorCodes.INVALID_SKILL_NAME, 'Invalid skill name');
    }
  }

  private missing(message: string): never {
    throw new AppError(400, ErrorCodes.MISSING_FIELD, message);
  }

  private unknown(method: string): never {
    throw this.unknownError(method);
  }

  private unknownError(method: string): AppError {
    return new AppError(400, ErrorCodes.INTERNAL_ERROR, `Unknown method: ${method}`);
  }
}
