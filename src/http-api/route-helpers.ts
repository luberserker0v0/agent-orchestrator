import type { Request, Response } from 'express';
import type { ConversationState } from '../orchestrator/conversation-state.js';
import { ErrorCodes, isAppError } from '../utils/errors.js';

export function conversationId(req: Request): string {
  return req.params.id as string;
}

export function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function handleControllerError(res: Response, error: unknown, defaultStatus = 500): void {
  if (isAppError(error)) {
    sendError(res, error.statusCode, error.code, error.message);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  sendError(res, defaultStatus, ErrorCodes.INTERNAL_ERROR, message);
}

export function ensureConversation(state: ConversationState, res: Response, id: string): boolean {
  if (state.has(id)) return true;
  sendError(res, 404, ErrorCodes.CONVERSATION_NOT_FOUND, 'Conversation not found');
  return false;
}
