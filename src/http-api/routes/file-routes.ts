import type { Express, Request, Response } from 'express';
import type { ConversationState } from '../../orchestrator/conversation-state.js';
import type { FileService } from '../../services/file-service.js';
import { ErrorCodes } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { conversationId, ensureConversation, handleControllerError, sendError } from '../route-helpers.js';

export function registerFileRoutes(app: Express, state: ConversationState, files: FileService): void {
  app.put('/api/conversations/:id/files', async (req, res) => withConversation(req, res, state, async id => {
    const path = stringField(req.body, 'path');
    const content = stringField(req.body, 'content');
    if (path === undefined || content === undefined) return sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing path or content');
    await execute(res, `write file ${path} for ${id}`, () => files.write(id, path, content), 204);
  }));
  app.post('/api/conversations/:id/files/read', async (req, res) => withConversation(req, res, state, async id => {
    const path = stringField(req.body, 'path');
    if (!path) return sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing path');
    try {
      res.json({ path, content: await files.read(id, path) });
    } catch (error) {
      handleControllerError(res, error, 404);
    }
  }));
  app.post('/api/conversations/:id/files/delete', async (req, res) => withConversation(req, res, state, async id => {
    const path = stringField(req.body, 'path');
    if (!path) return sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing path');
    await execute(res, `delete file ${path} for ${id}`, () => files.delete(id, path), 204);
  }));
  registerCopyAndList(app, state, files);
}

function registerCopyAndList(app: Express, state: ConversationState, files: FileService): void {
  app.post('/api/conversations/:id/files/copy', async (req, res) => withConversation(req, res, state, async id => {
    const source = stringField(req.body, 'source');
    const dest = stringField(req.body, 'dest');
    if (!source || !dest) return sendError(res, 400, ErrorCodes.MISSING_FIELD, 'Missing source or dest');
    await execute(res, `copy file for ${id}`, () => files.copy(id, source, dest), 204);
  }));
  app.post('/api/conversations/:id/files/list', async (req, res) => withConversation(req, res, state, async id => {
    const path = stringField(req.body, 'path');
    try {
      res.json({ path: path || '.', files: await files.list(id, path) });
    } catch (error) {
      handleControllerError(res, error);
    }
  }));
}

async function execute(res: Response, context: string, operation: () => Promise<void>, status: number): Promise<void> {
  try {
    await operation();
    res.status(status).send();
  } catch (error) {
    logger.error(`Failed to ${context}:`, error);
    handleControllerError(res, error);
  }
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

function stringField(body: unknown, name: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}
