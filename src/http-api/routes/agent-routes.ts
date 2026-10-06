import type { Express, Request, Response } from 'express';
import type { ConversationState } from '../../orchestrator/conversation-state.js';
import type { AgentService } from '../../services/agent-service.js';
import { ErrorCodes } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { conversationId, ensureConversation, handleControllerError, sendError } from '../route-helpers.js';

export function registerAgentRoutes(app: Express, state: ConversationState, agents: AgentService): void {
  registerAgentDefinitions(app, state, agents);
  registerAgentsDocument(app, state, agents);
}

function registerAgentDefinitions(app: Express, state: ConversationState, agents: AgentService): void {
  app.put('/api/conversations/:id/agents', (req, res) => withConversation(req, res, state, id => {
    const name = typeof req.body.name === 'string' ? req.body.name : undefined;
    const content = typeof req.body.content === 'string' ? req.body.content : undefined;
    if (!name || content === undefined) return sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing name or content');
    try {
      agents.writeAgent(id, name, content);
      res.status(204).send();
    } catch (error) {
      logger.error(`Failed to register agent ${name} for ${id}:`, error);
      handleControllerError(res, error);
    }
  }));
  app.get('/api/conversations/:id/agents', async (req, res) => withConversation(req, res, state, async id => {
    try {
      res.json(await agents.listAgentsWithRuntime(id));
    } catch (error) {
      handleControllerError(res, error);
    }
  }));
  app.get('/api/conversations/:id/agents/:name', (req, res) => withConversation(req, res, state, id => {
    try {
      res.json({ name: req.params.name as string, content: agents.readAgent(id, req.params.name as string) });
    } catch (error) {
      handleControllerError(res, error, 404);
    }
  }));
  app.delete('/api/conversations/:id/agents/:name', (req, res) => withConversation(req, res, state, id => {
    try {
      agents.deleteAgent(id, req.params.name as string);
      res.status(204).send();
    } catch (error) {
      handleControllerError(res, error);
    }
  }));
}

function registerAgentsDocument(app: Express, state: ConversationState, agents: AgentService): void {
  app.put('/api/conversations/:id/agent/config', (req, res) => withConversation(req, res, state, id => {
    const content = typeof req.body.content === 'string' ? req.body.content : undefined;
    if (content === undefined) return sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing content');
    try {
      agents.writeAgentsMd(id, content);
      res.status(204).send();
    } catch (error) {
      logger.error(`Failed to write AGENTS.md for ${id}:`, error);
      handleControllerError(res, error);
    }
  }));
  app.get('/api/conversations/:id/agent/config', (req, res) => withConversation(req, res, state, id => {
    try {
      res.json({ content: agents.readAgentsMd(id) });
    } catch (error) {
      handleControllerError(res, error, 404);
    }
  }));
  app.delete('/api/conversations/:id/agent/config', (req, res) => withConversation(req, res, state, id => {
    try {
      agents.deleteAgentsMd(id);
      res.status(204).send();
    } catch (error) {
      logger.error(`Failed to delete AGENTS.md for ${id}:`, error);
      handleControllerError(res, error);
    }
  }));
}

function withConversation(
  req: Request,
  res: Response,
  state: ConversationState,
  operation: (id: string) => void | Promise<void>,
): void | Promise<void> {
  const id = conversationId(req);
  if (!ensureConversation(state, res, id)) return;
  return operation(id);
}
