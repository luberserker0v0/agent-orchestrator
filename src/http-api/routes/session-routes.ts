import type { Express, Request, Response } from 'express';
import type { MessageService } from '../../services/message-service.js';
import type { SessionService } from '../../services/session-service.js';
import { ErrorCodes } from '../../utils/errors.js';
import { conversationId, handleControllerError, sendError } from '../route-helpers.js';

export function registerSessionRoutes(app: Express, sessions: SessionService, messages: MessageService): void {
  registerSessionCollection(app, sessions);
  registerSessionItem(app, sessions, messages);
  registerMessaging(app, sessions, messages);
}

function registerSessionCollection(app: Express, sessions: SessionService): void {
  app.post('/api/conversations/:id/sessions', async (req, res) => proxy(res, async () => {
    res.status(201).json(await sessions.create(conversationId(req), req.body));
  }));
  app.get('/api/conversations/:id/sessions', async (req, res) => proxy(res, async () => {
    res.json(await sessions.list(conversationId(req)));
  }));
  app.post('/api/conversations/:id/sessions/abort', async (req, res) => proxy(res, async () => {
    res.json(await sessions.abort(conversationId(req)));
  }));
  app.get('/api/conversations/:id/providers', async (req, res) => proxy(res, async () => {
    res.json(await sessions.listProviders(conversationId(req)));
  }));
}

function registerSessionItem(app: Express, sessions: SessionService, messages: MessageService): void {
  app.get('/api/conversations/:id/sessions/:sid', async (req, res) => proxy(res, async () => {
    res.json(await sessions.get(conversationId(req), req.params.sid as string));
  }));
  app.get('/api/conversations/:id/sessions/:sid/children', async (req, res) => proxy(res, async () => {
    res.json(await sessions.getChildren(conversationId(req), req.params.sid as string));
  }));
  app.post('/api/conversations/:id/sessions/:sid/fork', async (req, res) => proxy(res, async () => {
    res.status(201).json(await sessions.fork(conversationId(req), req.params.sid as string, req.body.messageID));
  }));
  app.delete('/api/conversations/:id/sessions/:sid', async (req, res) => proxy(res, async () => {
    await sessions.delete(conversationId(req), req.params.sid as string);
    res.status(204).send();
  }));
  app.get('/api/conversations/:id/sessions/:sid/messages', async (req, res) => proxy(res, async () => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await messages.getHistory(conversationId(req), req.params.sid as string, limit));
  }));
}

function registerMessaging(app: Express, _sessions: SessionService, messages: MessageService): void {
  app.post('/api/conversations/:id/message', async (req: Request, res: Response) => {
    const { text, model, agent } = req.body as { text?: string; model?: string; agent?: string };
    if (!text || typeof text !== 'string') return sendError(res, 400, ErrorCodes.INVALID_TEXT, 'Missing or invalid text field');
    await proxy(res, async () => {
      res.json(await messages.send(conversationId(req), text, model, agent));
    });
  });
}

async function proxy(res: Response, operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    handleControllerError(res, error);
  }
}
