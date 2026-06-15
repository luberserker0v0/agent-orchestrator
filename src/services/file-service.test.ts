import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('../orchestrator/workspace-factory.js', () => ({
  WorkspaceFactory: class {},
  getDirSize: vi.fn().mockReturnValue(0),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { getDirSize } from '../orchestrator/workspace-factory.js';
import { FileService } from './file-service.js';

describe('FileService', () => {
  let service: FileService;
  let mockWorkspaceFactory: any;
  let mockConversationState: any;
  const testId = 'conv-1';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);

    mockWorkspaceFactory = {
      resolveWorkspacePath: vi.fn().mockReturnValue('/tmp/ws/conv-1'),
      writeFile: vi.fn(),
      readFile: vi.fn(),
      deleteFile: vi.fn(),
      copyFromLocal: vi.fn(),
      listFiles: vi.fn(),
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
    it('should write file content', () => {
      service.write(testId, 'test.txt', 'content');

      expect(mockWorkspaceFactory.writeFile).toHaveBeenCalledWith(testId, 'test.txt', 'content');
    });

    it('should mark needsRestart when conversation is running', () => {
      makeRunning();

      service.write(testId, 'test.txt', 'content');

      expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith(testId, 'file test.txt updated');
    });

    it('should throw 400 for path traversal', () => {
      mockWorkspaceFactory.writeFile.mockImplementation(() => { throw new Error('path traversal detected'); });

      try { service.write(testId, '../evil.txt', 'content'); } catch (e: any) {
        expect(e.statusCode).toBe(400);
        expect(e.code).toBe('PATH_TRAVERSAL');
      }
    });

    it('should throw 400 for invalid path', () => {
      mockWorkspaceFactory.writeFile.mockImplementation(() => { throw new Error('Invalid path'); });

      try { service.write(testId, '', 'content'); } catch (e: any) {
        expect(e.statusCode).toBe(400);
        expect(e.code).toBe('INVALID_PATH');
      }
    });

    it('should throw 413 for quota exceeded', () => {
      vi.mocked(getDirSize).mockReturnValue(52 * 1024 * 1024);

      try { service.write(testId, 'big.txt', 'x'.repeat(1024)); } catch (e: any) {
        expect(e.statusCode).toBe(413);
      }
    });
  });

  describe('read', () => {
    it('should return file content', () => {
      mockWorkspaceFactory.readFile.mockReturnValue('file content');

      const result = service.read(testId, 'test.txt');

      expect(result).toBe('file content');
    });

    it('should throw 404 when file not found', () => {
      mockWorkspaceFactory.readFile.mockImplementation(() => { throw new Error('File not found: test.txt'); });

      try { service.read(testId, 'missing.txt'); } catch (e: any) {
        expect(e.statusCode).toBe(404);
        expect(e.code).toBe('FILE_NOT_FOUND');
      }
    });
  });

  describe('delete', () => {
    it('should delete a file', () => {
      service.delete(testId, 'test.txt');

      expect(mockWorkspaceFactory.deleteFile).toHaveBeenCalledWith(testId, 'test.txt');
    });

    it('should mark needsRestart when running', () => {
      makeRunning();

      service.delete(testId, 'test.txt');

      expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith(testId, 'file test.txt deleted');
    });

    it('should throw 404 when file not found', () => {
      mockWorkspaceFactory.deleteFile.mockImplementation(() => { throw new Error('File not found: test.txt'); });

      try { service.delete(testId, 'missing.txt'); } catch (e: any) {
        expect(e.statusCode).toBe(404);
      }
    });
  });

  describe('copy', () => {
    it('should copy file', () => {
      service.copy(testId, '/source/file.txt', 'dest/file.txt');

      expect(mockWorkspaceFactory.copyFromLocal).toHaveBeenCalledWith(testId, '/source/file.txt', 'dest/file.txt');
    });

    it('should mark needsRestart when running', () => {
      makeRunning();

      service.copy(testId, '/source/file.txt', 'dest/file.txt');

      expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith(testId, 'file copied to dest/file.txt');
    });

    it('should wrap unknown error as AppError', () => {
      mockWorkspaceFactory.copyFromLocal.mockImplementation(() => { throw new Error('disk full'); });

      try { service.copy(testId, '/source/file.txt', 'dest/file.txt'); } catch (e: any) {
        expect(e.statusCode).toBe(500);
      }
    });
  });

  describe('list', () => {
    it('should list files', () => {
      mockWorkspaceFactory.listFiles.mockReturnValue(['a.txt', 'b.txt']);

      const result = service.list(testId);

      expect(result).toEqual(['a.txt', 'b.txt']);
    });

    it('should throw 404 when directory not found', () => {
      mockWorkspaceFactory.listFiles.mockImplementation(() => { throw new Error('Directory not found: missing'); });

      try { service.list(testId, 'missing'); } catch (e: any) {
        expect(e.statusCode).toBe(404);
      }
    });
  });
});
