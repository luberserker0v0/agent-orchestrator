export const ErrorCodes = {
  CONVERSATION_NOT_FOUND: 'CONVERSATION_NOT_FOUND',
  CONVERSATION_ALREADY_EXISTS: 'CONVERSATION_ALREADY_EXISTS',
  CONVERSATION_ALREADY_RUNNING: 'CONVERSATION_ALREADY_RUNNING',
  CONVERSATION_NOT_RUNNING: 'CONVERSATION_NOT_RUNNING',
  CANNOT_STOP: 'CANNOT_STOP',
  CANNOT_RESTART: 'CANNOT_RESTART',
  UNKNOWN_AGENT_TYPE: 'UNKNOWN_AGENT_TYPE',
  MISSING_FIELD: 'MISSING_FIELD',
  INVALID_REQUEST_BODY: 'INVALID_REQUEST_BODY',
  INVALID_SKILL_NAME: 'INVALID_SKILL_NAME',
  INSTANCE_NOT_READY: 'INSTANCE_NOT_READY',
  INSTANCE_REFERENCE_LOST: 'INSTANCE_REFERENCE_LOST',
  SESSION_NOT_READY: 'SESSION_NOT_READY',
  PATH_TRAVERSAL: 'PATH_TRAVERSAL',
  INVALID_PATH: 'INVALID_PATH',
  SKILL_INVALID_ARCHIVE: 'SKILL_INVALID_ARCHIVE',
  SKILL_QUOTA_EXCEEDED: 'SKILL_QUOTA_EXCEEDED',
  SOURCE_NOT_ALLOWED: 'SOURCE_NOT_ALLOWED',
  SOURCE_NOT_FOUND: 'SOURCE_NOT_FOUND',
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  INVALID_TEXT: 'INVALID_TEXT',
  WORKSPACE_QUOTA_EXCEEDED: 'WORKSPACE_QUOTA_EXCEEDED',
} as const;

export type ErrorCode = string;

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }

  toJSON(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function toHttpErrorResponse(err: unknown): { error: { code: string; message: string } } {
  if (err instanceof AppError) {
    return { error: err.toJSON() };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { error: { code: ErrorCodes.INTERNAL_ERROR, message } };
}
