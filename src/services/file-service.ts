import { WorkspaceFactory } from '../orchestrator/workspace-factory.js';
import { ConversationState } from '../orchestrator/conversation-state.js';
import { AppError, ErrorCodes } from '../utils/errors.js';

export class FileService {
  constructor(
    private workspaceFactory: WorkspaceFactory,
    private conversationState: ConversationState
  ) {}

  async write(id: string, path: string, content: string): Promise<void> {
    try {
      await this.workspaceFactory.writeFile(id, path, content);
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
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || message.startsWith('File not found') || message.startsWith('Directory not found')) {
      return new AppError(404, ErrorCodes.FILE_NOT_FOUND, message);
    }
    return new AppError(500, ErrorCodes.INTERNAL_ERROR, message);
  }

  async read(id: string, path: string): Promise<string> {
    try {
      return await this.workspaceFactory.readFile(id, path);
    } catch (err) {
      throw this.toAppError(err);
    }
  }

  async delete(id: string, path: string): Promise<void> {
    try {
      await this.workspaceFactory.deleteFile(id, path);
    } catch (err) {
      throw this.toAppError(err);
    }
    this.markNeedsRestartIfRunning(id, `file ${path} deleted`);
  }

  async copy(id: string, source: string, dest: string): Promise<void> {
    try {
      await this.workspaceFactory.copyFromLocal(id, source, dest);
    } catch (err) {
      throw err instanceof AppError ? err : new AppError(500, ErrorCodes.INTERNAL_ERROR, (err as Error).message);
    }
    this.markNeedsRestartIfRunning(id, `file copied to ${dest}`);
  }

  async list(id: string, path?: string): Promise<string[]> {
    try {
      return await this.workspaceFactory.listFiles(id, path);
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
}
