import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import type { ConversationState } from '../../orchestrator/conversation-state.js';
import { validateAgentName, validateSkillName } from '../../orchestrator/workspace-factory.js';
import type { SkillService } from '../../services/skill-service.js';
import { ErrorCodes, isAppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { conversationId, ensureConversation, handleControllerError, sendError } from '../route-helpers.js';

interface SkillScope {
  conversation: string;
  agent?: string;
}

export function registerSkillRoutes(app: Express, state: ConversationState, skills: SkillService): void {
  const controller = new SkillRouteController(state, skills);
  const rawZip = express.raw({ type: 'application/zip', limit: '10mb' });
  registerScope(app, '/api/conversations/:id/skills', false, rawZip, controller);
  registerScope(app, '/api/conversations/:id/agents/:agent/skills', true, rawZip, controller);
}

function registerScope(
  app: Express,
  base: string,
  agentScoped: boolean,
  rawZip: RequestHandler,
  controller: SkillRouteController,
): void {
  app.post(`${base}/upload`, rawZip, controller.upload(agentScoped));
  app.post(`${base}/import`, controller.import(agentScoped));
  app.get(base, controller.list(agentScoped));
  app.get(`${base}/:name`, controller.read(agentScoped));
  app.get(`${base}/:name/info`, controller.info(agentScoped));
  app.delete(`${base}/:name`, controller.delete(agentScoped));
}

class SkillRouteController {
  constructor(
    private readonly state: ConversationState,
    private readonly skills: SkillService,
  ) {}

  upload(agentScoped: boolean): RequestHandler {
    return async (req, res) => {
      const scope = this.scope(req, res, agentScoped);
      if (!scope) return;
      const name = typeof req.query.name === 'string' ? req.query.name : undefined;
      if (!name) return sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing name query parameter');
      if (!this.validSkillName(res, name)) return;
      try {
        await this.uploadSkill(scope, name, requestBuffer(req.body));
        res.status(204).send();
      } catch (error) {
        logger.error(`Failed to upload skill for ${scope.conversation}${scope.agent ? ` agent ${scope.agent}` : ''}:`, error);
        this.skillMutationError(res, error, 'upload');
      }
    };
  }

  import(agentScoped: boolean): RequestHandler {
    return async (req, res) => {
      const scope = this.scope(req, res, agentScoped);
      if (!scope) return;
      const source = typeof req.body.source === 'string' ? req.body.source : undefined;
      const name = typeof req.body.name === 'string' ? req.body.name : undefined;
      if (!source || !name) return sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing source or name');
      if (!this.validSkillName(res, name)) return;
      try {
        await this.importSkill(scope, source, name);
        res.status(204).send();
      } catch (error) {
        logger.error(`Failed to import skill for ${scope.conversation}${scope.agent ? ` agent ${scope.agent}` : ''}:`, error);
        this.skillMutationError(res, error, 'import');
      }
    };
  }

  list(agentScoped: boolean): RequestHandler {
    return (req, res) => {
      const scope = this.scope(req, res, agentScoped);
      if (!scope) return;
      try {
        res.json(scope.agent
          ? this.skills.listSkills(scope.conversation, scope.agent)
          : this.skills.listSkills(scope.conversation));
      } catch (error) {
        handleControllerError(res, error);
      }
    };
  }

  read(agentScoped: boolean): RequestHandler {
    return (req, res) => this.withNamedSkill(req, res, agentScoped, (scope, name) => {
      const content = scope.agent
        ? this.skills.readSkill(scope.conversation, name, scope.agent)
        : this.skills.readSkill(scope.conversation, name);
      res.json({ name, content });
    });
  }

  info(agentScoped: boolean): RequestHandler {
    return (req, res) => this.withNamedSkill(req, res, agentScoped, (scope, name) => {
      res.json(scope.agent
        ? this.skills.getSkillInfo(scope.conversation, name, scope.agent)
        : this.skills.getSkillInfo(scope.conversation, name));
    });
  }

  delete(agentScoped: boolean): RequestHandler {
    return (req, res) => this.withNamedSkill(req, res, agentScoped, (scope, name) => {
      try {
        if (scope.agent) this.skills.deleteSkill(scope.conversation, name, scope.agent);
        else this.skills.deleteSkill(scope.conversation, name);
        res.status(204).send();
      } catch (error) {
        this.skillDeleteError(res, error);
      }
    }, false);
  }

  private scope(req: Request, res: Response, agentScoped: boolean): SkillScope | undefined {
    const conversation = conversationId(req);
    if (!ensureConversation(this.state, res, conversation)) return undefined;
    if (!agentScoped) return { conversation };
    const rawAgent = req.params.agent;
    if (typeof rawAgent !== 'string' || !rawAgent) {
      sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing agent parameter');
      return undefined;
    }
    try {
      return { conversation, agent: validateAgentName(rawAgent) };
    } catch {
      sendError(res, 400, ErrorCodes.INVALID_AGENT_NAME, 'Invalid agent name');
      return undefined;
    }
  }

  private withNamedSkill(
    req: Request,
    res: Response,
    agentScoped: boolean,
    operation: (scope: SkillScope, name: string) => void,
    handleError = true,
  ): void {
    const scope = this.scope(req, res, agentScoped);
    if (!scope) return;
    const name = req.params.name as string;
    if (!this.validSkillName(res, name)) return;
    try {
      operation(scope, name);
    } catch (error) {
      if (handleError) handleControllerError(res, error, 404);
      else throw error;
    }
  }

  private validSkillName(res: Response, name: string): boolean {
    try {
      validateSkillName(name);
      return true;
    } catch {
      sendError(res, 400, ErrorCodes.INVALID_SKILL_NAME, 'Invalid skill name');
      return false;
    }
  }

  private uploadSkill(scope: SkillScope, name: string, archive: Buffer): Promise<void> {
    return scope.agent
      ? this.skills.uploadSkill(scope.conversation, name, archive, scope.agent)
      : this.skills.uploadSkill(scope.conversation, name, archive);
  }

  private importSkill(scope: SkillScope, source: string, name: string): Promise<void> {
    return scope.agent
      ? this.skills.importSkill(scope.conversation, source, name, scope.agent)
      : this.skills.importSkill(scope.conversation, source, name);
  }

  private skillMutationError(res: Response, error: unknown, operation: 'upload' | 'import'): void {
    if (isAppError(error)) return sendError(res, error.statusCode, error.code, error.message);
    const message = error instanceof Error ? error.message : String(error);
    if (operation === 'upload' && (message.includes('Skill archive must contain SKILL.md') || message.includes('Invalid zip entry path'))) {
      return sendError(res, 400, ErrorCodes.SKILL_INVALID_ARCHIVE, message);
    }
    if (operation === 'import' && message.includes('Source path not allowed')) return sendError(res, 403, ErrorCodes.SOURCE_NOT_ALLOWED, message);
    if (operation === 'import' && (message.includes('Source not found') || message.includes('Source must be a directory'))) {
      return sendError(res, 404, ErrorCodes.SOURCE_NOT_FOUND, message);
    }
    if (message.includes('Workspace quota exceeded')) {
      const code = operation === 'upload' ? ErrorCodes.SKILL_QUOTA_EXCEEDED : ErrorCodes.WORKSPACE_QUOTA_EXCEEDED;
      return sendError(res, 413, code, operation === 'upload' ? 'Skill archive exceeds workspace quota' : message);
    }
    sendError(res, 500, ErrorCodes.INTERNAL_ERROR, message);
  }

  private skillDeleteError(res: Response, error: unknown): void {
    if (isAppError(error)) return sendError(res, error.statusCode, error.code, error.message);
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Skill not found')) return sendError(res, 404, ErrorCodes.SKILL_NOT_FOUND, message);
    sendError(res, 500, ErrorCodes.INTERNAL_ERROR, message);
  }
}

function requestBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  const data = value && typeof value === 'object' ? (value as { data?: unknown }).data : undefined;
  return Array.isArray(data) ? Buffer.from(data) : Buffer.alloc(0);
}
