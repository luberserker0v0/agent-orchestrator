import type { Express, Request, Response } from 'express';
import type { ConversationService } from '../../services/conversation-service.js';
import { AppError, ErrorCodes } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { conversationId, handleControllerError } from '../route-helpers.js';

export function registerConversationRoutes(app: Express, conversations: ConversationService): void {
  registerCreationAndQueries(app, conversations);
  registerLifecycleActions(app, conversations);
}

function registerCreationAndQueries(app: Express, conversations: ConversationService): void {
  app.post('/api/conversations', async (req, res) => execute(res, 'create conversation', async () => {
    const id = typeof req.body.id === 'string' ? req.body.id : undefined;
    const agentType = typeof req.body.agentType === 'string' ? req.body.agentType : undefined;
    res.status(201).json(await conversations.create(id, agentType));
  }));
  app.get('/api/conversations', (_req, res) => res.json(conversations.list()));
  app.get('/api/conversations/:id', (req, res) => execute(res, undefined, () => {
    res.json(conversations.get(conversationId(req)));
  }));
  app.get('/api/conversations/:id/events', (req, res) => execute(res, undefined, () => {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    res.json(conversations.getEvents(conversationId(req), limit));
  }));
}

function registerLifecycleActions(app: Express, conversations: ConversationService): void {
  app.post('/api/conversations/:id/start', async (req, res) => executeForConversation(req, res, 'start', async id => {
    res.json(await conversations.start(id));
  }));
  app.post('/api/conversations/:id/stop', async (req, res) => executeForConversation(req, res, 'stop', async id => {
    await conversations.stop(id);
    res.json({ id, status: 'stopped' });
  }));
  app.post('/api/conversations/:id/restart', async (req, res) => executeForConversation(req, res, 'restart', async id => {
    res.json(await conversations.restart(id));
  }));
  app.post('/api/conversations/:id/migrate', async (req, res) => executeForConversation(req, res, 'migrate', async id => {
    const nodeName = (req.body as { nodeName?: unknown } | undefined)?.nodeName;
    if (typeof nodeName !== 'string' || !nodeName) throw new AppError(400, ErrorCodes.MISSING_FIELD, 'Body must include a non-empty "nodeName"');
    res.json(await conversations.migrateInstance(id, { nodeName }));
  }));
  app.delete('/api/conversations/:id', async (req, res) => executeForConversation(req, res, 'delete', async id => {
    await conversations.delete(id);
    res.status(204).send();
  }));
}

async function executeForConversation(
  req: Request,
  res: Response,
  action: string,
  operation: (id: string) => void | Promise<void>,
): Promise<void> {
  const id = conversationId(req);
  await execute(res, `${action} conversation ${id}`, () => operation(id));
}

async function execute(res: Response, logContext: string | undefined, operation: () => void | Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (logContext) logger.error(`Failed to ${logContext}:`, error);
    handleControllerError(res, error);
  }
}
