import type { Express, Request, Response } from 'express';
import type { OpencodeConfig } from '../../opencode-http/types.js';
import type { ConversationState } from '../../orchestrator/conversation-state.js';
import type { ConfigService } from '../../services/config-service.js';
import { ErrorCodes } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { conversationId, ensureConversation, handleControllerError, sendError } from '../route-helpers.js';

export function registerConfigRoutes(app: Express, state: ConversationState, configs: ConfigService): void {
  app.get('/api/conversations/:id/config', async (req, res) => {
    const id = conversationId(req);
    if (!ensureConversation(state, res, id)) return;
    try {
      res.json(await configs.readConfig(id));
    } catch (error) {
      handleControllerError(res, error);
    }
  });
  app.post('/api/conversations/:id/config', async (req, res) => writeConfig('write', req.body, req, res, state, configs));
  app.patch('/api/conversations/:id/config', async (req, res) => writeConfig('patch', req.body, req, res, state, configs));
}

async function writeConfig(
  mode: 'write' | 'patch',
  value: unknown,
  req: Request,
  res: Response,
  state: ConversationState,
  configs: ConfigService,
): Promise<void> {
  const id = conversationId(req);
  if (!ensureConversation(state, res, id)) return;
  if (typeof value !== 'object' || value === null) return sendError(res, 400, ErrorCodes.INVALID_REQUEST_BODY, 'Request body must be a JSON object');
  try {
    if (mode === 'write') await configs.writeConfig(id, value as OpencodeConfig);
    else await configs.patchConfig(id, value as Record<string, unknown>);
    res.status(204).send();
  } catch (error) {
    logger.error(`Failed to ${mode} config for ${id}:`, error);
    handleControllerError(res, error);
  }
}
