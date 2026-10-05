import { previewFileLogCleanup, pruneFileLogs } from '../utils/logger.js';
import type { CleanupArtifact, CleanupArtifactResult, CleanupProvider } from './types.js';

export class FileLogCleanupProvider implements CleanupProvider {
  readonly target = 'logs' as const;
  readonly backend = 'filesystem' as const;

  constructor(readonly enabled: boolean) {}

  async preview(now: number): Promise<CleanupArtifact[]> {
    if (!this.enabled) return [];
    const candidates = await previewFileLogCleanup(new Date(now));
    return candidates.map(candidate => ({
      target: this.target,
      artifactId: candidate.artifactId,
      backend: 'filesystem',
      state: 'eligible',
      reason: candidate.reason,
      sizeBytes: candidate.sizeBytes,
      lastModifiedAt: candidate.lastModifiedAt,
    }));
  }

  async run(now: number): Promise<CleanupArtifactResult[]> {
    if (!this.enabled) return [];
    const result = await pruneFileLogs(new Date(now));
    return result.outcomes.map(outcome => ({
      target: this.target,
      artifactId: outcome.artifactId,
      backend: 'filesystem',
      state: 'eligible',
      reason: outcome.reason,
      sizeBytes: outcome.sizeBytes,
      lastModifiedAt: outcome.lastModifiedAt,
      outcome: outcome.status,
      ...(outcome.errorCode ? { code: outcome.errorCode, message: 'Unable to delete rotated log file' } : {}),
    }));
  }
}
