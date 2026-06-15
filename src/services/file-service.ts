import { WorkspaceFactory, getDirSize } from '../orchestrator/workspace-factory.js';
import { ConversationState } from '../orchestrator/conversation-state.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import { existsSync, readFileSync } from 'node:fs';

export class FileService {
  constructor(
    private workspaceFactory: WorkspaceFactory,
    private conversationState: ConversationState
  ) {}

  write(id: string, path: string, content: string): void {
    const wsPath = this.workspaceFactory.resolveWorkspacePath(id);
    const size = Buffer.byteLength(content, 'utf-8');
    this.assertQuota(wsPath, size);

    try {
      this.workspaceFactory.writeFile(id, path, content);
    } catch (err) {
      const message = (err as Error).message;
      if (message.includes('path traversal')) {
        throw new AppError(400, ErrorCodes.PATH_TRAVERSAL, message);
      }
      if (message.includes('Invalid path')) {
        throw new AppError(400, ErrorCodes.INVALID_PATH, message);
      }
      throw err instanceof AppError ? err : new AppError(500, ErrorCodes.INTERNAL_ERROR, (err as Error).message);
    }

    this.markNeedsRestartIfRunning(id, `file ${path} updated`);
  }

  private toAppError(err: unknown): AppError {
    if (err instanceof AppError) return err;
    const message = (err as Error).message;
    if (message.startsWith('File not found') || message.startsWith('Directory not found')) {
      return new AppError(404, ErrorCodes.FILE_NOT_FOUND, message);
    }
    return new AppError(500, ErrorCodes.INTERNAL_ERROR, message);
  }

  read(id: string, path: string): string {
    try {
      return this.workspaceFactory.readFile(id, path);
    } catch (err) {
      throw this.toAppError(err);
    }
  }

  delete(id: string, path: string): void {
    try {
      this.workspaceFactory.deleteFile(id, path);
    } catch (err) {
      throw this.toAppError(err);
    }
    this.markNeedsRestartIfRunning(id, `file ${path} deleted`);
  }

  copy(id: string, source: string, dest: string): void {
    try {
      this.workspaceFactory.copyFromLocal(id, source, dest);
    } catch (err) {
      throw err instanceof AppError ? err : new AppError(500, ErrorCodes.INTERNAL_ERROR, (err as Error).message);
    }
    this.markNeedsRestartIfRunning(id, `file copied to ${dest}`);
  }

  list(id: string, path?: string): string[] {
    try {
      return this.workspaceFactory.listFiles(id, path);
    } catch (err) {
      throw this.toAppError(err);
    }
  }

  private markNeedsRestartIfRunning(id: string, reason: string): void {
    const state = this.conversationState.get(id);
    if (state && state.status === 'running') {
      this.conversationState.markNeedsRestart(id, reason);
    }
  }

  private assertQuota(wsPath: string, additionalBytes: number, excludingFile?: string): void {
    const currentSize = getDirSize(wsPath);
    let excluding = 0;
    if (excludingFile) {
      if (existsSync(excludingFile)) {
        try {
          excluding = readFileSync(excludingFile).length;
        } catch {
          // ignore
        }
      }
    }
    const MAX_WORKSPACE_SIZE = 50 * 1024 * 1024;
    if (currentSize - excluding + additionalBytes > MAX_WORKSPACE_SIZE) {
      throw new AppError(413, ErrorCodes.WORKSPACE_QUOTA_EXCEEDED,
        `Workspace quota exceeded. Current: ${currentSize} bytes, Adding: ${additionalBytes} bytes, Limit: ${MAX_WORKSPACE_SIZE} bytes`);
    }
  }
}
