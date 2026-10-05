import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileLogCleanupProvider } from './file-log-provider.js';
import { previewFileLogCleanup, pruneFileLogs } from '../utils/logger.js';

vi.mock('../utils/logger.js', () => ({
  previewFileLogCleanup: vi.fn(),
  pruneFileLogs: vi.fn(),
}));

describe('FileLogCleanupProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not touch the sink when disabled', async () => {
    const provider = new FileLogCleanupProvider(false);
    expect(await provider.preview(100)).toEqual([]);
    expect(await provider.run(100)).toEqual([]);
    expect(previewFileLogCleanup).not.toHaveBeenCalled();
  });

  it('maps preview candidates without exposing paths', async () => {
    vi.mocked(previewFileLogCleanup).mockResolvedValueOnce([
      { artifactId: 'agentorchestrator.old.jsonl', lastModifiedAt: 10, sizeBytes: 22, reason: 'age' },
    ]);
    const provider = new FileLogCleanupProvider(true);
    expect(await provider.preview(100)).toEqual([expect.objectContaining({
      target: 'logs', artifactId: 'agentorchestrator.old.jsonl', backend: 'filesystem',
      state: 'eligible', reason: 'age', sizeBytes: 22,
    })]);
  });

  it('maps successful and failed prune outcomes', async () => {
    vi.mocked(pruneFileLogs).mockResolvedValueOnce({
      scanned: 2, eligible: 2, deleted: 1, failed: 1, reclaimedBytes: 20, candidates: [],
      outcomes: [
        { artifactId: 'one.jsonl', lastModifiedAt: 1, sizeBytes: 20, reason: 'age', status: 'deleted' },
        { artifactId: 'two.jsonl', lastModifiedAt: 2, sizeBytes: 30, reason: 'count', status: 'failed', errorCode: 'EACCES' },
      ],
    });
    const provider = new FileLogCleanupProvider(true);
    const outcomes = await provider.run(100);
    expect(outcomes.map(item => item.outcome)).toEqual(['deleted', 'failed']);
    expect(outcomes[1]).toMatchObject({ code: 'EACCES', message: 'Unable to delete rotated log file' });
  });
});
