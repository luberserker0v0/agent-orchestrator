import { describe, expect, it, vi } from 'vitest';
import { CleanupManager } from './cleanup-manager.js';
import { ErrorCodes } from '../utils/errors.js';
import { cleanupReclaimedBytesTotal } from '../metrics/registry.js';
import type { CleanupArtifact, CleanupArtifactResult, CleanupProvider } from './types.js';

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function provider(
  target: 'logs' | 'persistentData',
  enabled = true,
  previewItems: CleanupArtifact[] = [],
  runItems: CleanupArtifactResult[] = [],
): CleanupProvider {
  return {
    target,
    backend: 'filesystem',
    enabled,
    preview: vi.fn().mockResolvedValue(previewItems),
    run: vi.fn().mockResolvedValue(runItems),
  };
}

describe('CleanupManager', () => {
  it('aggregates enabled providers and known bytes in preview', async () => {
    const artifact: CleanupArtifact = {
      target: 'logs', artifactId: 'old.jsonl', backend: 'filesystem', state: 'eligible',
      reason: 'age', sizeBytes: 42,
    };
    const logs = provider('logs', true, [artifact]);
    const persistent = provider('persistentData', false);
    const manager = new CleanupManager([logs, persistent], 60_000, () => 100);

    const report = await manager.preview(['logs', 'persistentData']);

    expect(report.status).toBe('completed');
    expect(report.summary).toMatchObject({ scanned: 1, eligible: 1, eligibleBytes: 42 });
    expect(report.targets[1]).toMatchObject({ target: 'persistentData', enabled: false, scanned: 0 });
    expect(logs.preview).toHaveBeenCalledWith(100);
    expect(persistent.preview).not.toHaveBeenCalled();
  });

  it('reports partial runs without discarding successful outcomes', async () => {
    const logs = provider('logs', true, [], [
      {
        target: 'logs', artifactId: 'deleted.jsonl', backend: 'filesystem', state: 'eligible',
        reason: 'age', sizeBytes: 20, outcome: 'deleted',
      },
      {
        target: 'logs', artifactId: 'failed.jsonl', backend: 'filesystem', state: 'eligible',
        reason: 'age', sizeBytes: 10, outcome: 'failed', code: 'EACCES', message: 'unable to delete',
      },
    ]);
    const manager = new CleanupManager([logs], 60_000, () => 200);

    const report = await manager.run(['logs']);

    expect(report.status).toBe('partial');
    expect(report.summary).toMatchObject({ deleted: 1, failed: 1, reclaimedBytes: 20 });
  });

  it('keeps PVC byte totals unknown while still recording known reclaimed bytes', async () => {
    const local = provider('persistentData', true, [], [{
      target: 'persistentData', artifactId: 'local-generation', backend: 'filesystem', state: 'eligible',
      reason: 'orphan-grace-expired', sizeBytes: 25, outcome: 'deleted',
    }]);
    const kubernetes: CleanupProvider = {
      ...provider('persistentData', true, [], [{
        target: 'persistentData', artifactId: 'pvc-generation', backend: 'kubernetes', state: 'eligible',
        reason: 'orphan-retention-expired', sizeBytes: null, outcome: 'deleted',
      }]),
      backend: 'kubernetes',
    };
    const before = (await cleanupReclaimedBytesTotal.get()).values.find(
      value => value.labels.target === 'persistentData',
    )?.value ?? 0;
    const manager = new CleanupManager([local, kubernetes], 60_000, () => 250);

    const report = await manager.run(['persistentData']);

    expect(report.summary).toMatchObject({ deleted: 2, reclaimedBytes: null });
    const after = (await cleanupReclaimedBytesTotal.get()).values.find(
      value => value.labels.target === 'persistentData',
    )?.value ?? 0;
    expect(after - before).toBe(25);
  });

  it('rejects overlapping preview/run operations instead of queueing', async () => {
    let release!: () => void;
    const blocked = new Promise<CleanupArtifact[]>(resolve => { release = () => resolve([]); });
    const logs: CleanupProvider = {
      target: 'logs', backend: 'filesystem', enabled: true,
      preview: vi.fn(() => blocked),
      run: vi.fn().mockResolvedValue([]),
    };
    const manager = new CleanupManager([logs], 60_000);

    const first = manager.preview(['logs']);
    await expect(manager.run(['logs'])).rejects.toMatchObject({
      statusCode: 409,
      code: ErrorCodes.CLEANUP_IN_PROGRESS,
    });
    release();
    await first;
  });

  it('turns provider-wide run errors into a sanitized failed report', async () => {
    const localPersistentData = provider('persistentData');
    vi.mocked(localPersistentData.run).mockRejectedValueOnce(new Error('disk unavailable'));
    const manager = new CleanupManager([localPersistentData], 60_000, () => 300);

    const report = await manager.run(['persistentData']);

    expect(report.status).toBe('failed');
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({
      artifactId: 'provider-persistentData', backend: 'filesystem', outcome: 'failed', code: ErrorCodes.CLEANUP_FAILED,
      message: 'Cleanup provider failed; inspect server logs for details',
    });
  });

  it('waits for an active operation during shutdown', async () => {
    let release!: () => void;
    const blocked = new Promise<CleanupArtifactResult[]>(resolve => { release = () => resolve([]); });
    const logs: CleanupProvider = {
      target: 'logs', backend: 'filesystem', enabled: true,
      preview: vi.fn().mockResolvedValue([]),
      run: vi.fn(() => blocked),
    };
    const manager = new CleanupManager([logs], 60_000);

    const run = manager.runOnce(['logs']);
    let shutdownFinished = false;
    const shutdown = manager.shutdown().then(() => { shutdownFinished = true; });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    release();
    await Promise.all([run, shutdown]);
    expect(shutdownFinished).toBe(true);
  });

  it('rejects new operations once shutdown begins', async () => {
    const manager = new CleanupManager([provider('logs')], 60_000);

    await manager.shutdown();

    await expect(manager.preview(['logs'])).rejects.toMatchObject({
      statusCode: 503,
      code: ErrorCodes.CLEANUP_FAILED,
    });
  });

  it('starts one immediate scheduled sweep and stops its timer', async () => {
    vi.useFakeTimers();
    const logs = provider('logs');
    const manager = new CleanupManager([logs], 1000);

    manager.start();
    await vi.runOnlyPendingTimersAsync();
    expect(logs.run).toHaveBeenCalled();
    manager.stop();
    vi.useRealTimers();
  });
});
