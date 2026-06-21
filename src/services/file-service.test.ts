import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { FileService } from './file-service.js';

describe('FileService', () => {
  let service: FileService;
  let mockWorkspaceFactory: any;
  let mockConversationState: any;
  const testId = 'conv-1';

  beforeEach(() => {
    vi.clearAllMocks();

    mockWorkspaceFactory = {
      resolveWorkspacePath: vi.fn().mockReturnValue('/tmp/ws/conv-1'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue('file content'),
      deleteFile: vi.fn().mockResolvedValue(undefined),
      copyFromLocal: vi.fn().mockResolvedValue(undefined),
      listFiles: vi.fn().mockResolvedValue(['a.txt', 'b.txt']),
    };

    mockConversationState = {
      get: vi.fn().mockReturnValue({ status: 'prepared', ready: false }),
      markNeedsRestart: vi.fn(),
    };

    service = new FileService(mockWorkspaceFactory, mockConversationState);
  });

  function makeRunning(): void {
    mockConversationState.get.mockReturnValue({ status: 'running', ready: true });
  }

  describe('write', () => {
    it('should write file content', async () => {
      await service.write(testId, 'test.txt', 'content');

      expect(mockWorkspaceFactory.writeFile).toHaveBeenCalledWith(testId, 'test.txt', 'content');
    });

    it('should mark needsRestart when conversation is running', async () => {
      makeRunning();

      await service.write(testId, 'test.txt', 'content');

      expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith(testId, 'file test.txt updated');
    });

    it('should throw 400 for path traversal', async () => {
      mockWorkspaceFactory.writeFile.mockRejectedValue(new Error('path traversal detected'));

      try { await service.write(testId, '../evil.txt', 'content'); } catch (e: any) {
        expect(e.statusCode).toBe(400);
        expect(e.code).toBe('PATH_TRAVERSAL');
      }
    });

    it('should throw 400 for invalid path', async () => {
      mockWorkspaceFactory.writeFile.mockRejectedValue(new Error('Invalid path'));

      try { await service.write(testId, '', 'content'); } catch (e: any) {
        expect(e.statusCode).toBe(400);
        expect(e.code).toBe('INVALID_PATH');
      }
    });
  });

  describe('read', () => {
    it('should return file content', async () => {
      const result = await service.read(testId, 'test.txt');

      expect(result).toBe('file content');
    });

    it('should throw 404 when file not found', async () => {
      mockWorkspaceFactory.readFile.mockRejectedValue(new Error('File not found: test.txt'));

      try { await service.read(testId, 'missing.txt'); } catch (e: any) {
        expect(e.statusCode).toBe(404);
        expect(e.code).toBe('FILE_NOT_FOUND');
      }
    });
  });

  describe('delete', () => {
    it('should delete a file', async () => {
      await service.delete(testId, 'test.txt');

      expect(mockWorkspaceFactory.deleteFile).toHaveBeenCalledWith(testId, 'test.txt');
    });

    it('should mark needsRestart when running', async () => {
      makeRunning();

      await service.delete(testId, 'test.txt');

      expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith(testId, 'file test.txt deleted');
    });

    it('should throw 404 when file not found', async () => {
      mockWorkspaceFactory.deleteFile.mockRejectedValue(new Error('File not found: test.txt'));

      try { await service.delete(testId, 'missing.txt'); } catch (e: any) {
        expect(e.statusCode).toBe(404);
      }
    });
  });

  describe('copy', () => {
    it('should copy file', async () => {
      await service.copy(testId, '/source/file.txt', 'dest/file.txt');

      expect(mockWorkspaceFactory.copyFromLocal).toHaveBeenCalledWith(testId, '/source/file.txt', 'dest/file.txt');
    });

    it('should mark needsRestart when running', async () => {
      makeRunning();

      await service.copy(testId, '/source/file.txt', 'dest/file.txt');

      expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith(testId, 'file copied to dest/file.txt');
    });

    it('should wrap unknown error as AppError', async () => {
      mockWorkspaceFactory.copyFromLocal.mockRejectedValue(new Error('disk full'));

      try { await service.copy(testId, '/source/file.txt', 'dest/file.txt'); } catch (e: any) {
        expect(e.statusCode).toBe(500);
      }
    });
  });

  describe('list', () => {
    it('should list files', async () => {
      const result = await service.list(testId);

      expect(result).toEqual(['a.txt', 'b.txt']);
    });

    it('should throw 404 when directory not found', async () => {
      mockWorkspaceFactory.listFiles.mockRejectedValue(new Error('Directory not found: missing'));

      try { await service.list(testId, 'missing'); } catch (e: any) {
        expect(e.statusCode).toBe(404);
      }
    });
  });
});
