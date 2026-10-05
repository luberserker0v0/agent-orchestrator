import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  markSessionStorageDeletePending,
  readSessionOwnershipRecord,
  resolveSessionStorage,
  resolveSessionStorageLayout,
  writeSessionOwnershipRecord,
} from '../agent-runtime/session-storage.js';
import { LocalPersistentDataProvider } from './local-persistent-data-provider.js';

describe('LocalPersistentDataProvider', () => {
  let root: string;
  let protectedIds: Set<string>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ao-local-cleanup-'));
    protectedIds = new Set();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function provider(overrides: Partial<ConstructorParameters<typeof LocalPersistentDataProvider>[0]> = {}) {
    return new LocalPersistentDataProvider({
      enabled: true,
      ownerId: 'owner-a',
      gracePeriodMs: 100,
      roots: [{ runtimeId: 'direct-a', config: { sharedRoot: root } }],
      isProtected: (id) => protectedIds.has(id),
      ...overrides,
    });
  }

  it('does nothing when disabled', async () => {
    resolveSessionStorage({ sharedRoot: root }, 'disabled-data', 'owner-a');
    const cleanup = provider({ enabled: false });

    expect(await cleanup.preview(100)).toEqual([]);
    expect(await cleanup.run(100)).toEqual([]);
    expect(existsSync(join(root, 'disabled-data'))).toBe(true);
  });

  it('retries explicit delete tombstones without enabling orphan reaping', async () => {
    resolveSessionStorage({ sharedRoot: root }, 'pending-disabled', 'owner-a');
    markSessionStorageDeletePending({ sharedRoot: root }, 'pending-disabled', 'owner-a', 1_000);
    resolveSessionStorage({ sharedRoot: root }, 'ordinary-disabled', 'owner-a');
    const cleanup = provider({ enabled: false, retryPendingDeletes: true });

    const results = await cleanup.run(2_000);

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conversationId: 'pending-disabled',
        reason: 'delete-pending-retry',
        outcome: 'deleted',
      }),
    ]));
    expect(results.some(item => item.conversationId === 'ordinary-disabled')).toBe(false);
    expect(existsSync(join(root, 'pending-disabled'))).toBe(false);
    expect(existsSync(join(root, 'ordinary-disabled'))).toBe(true);
    expect(readSessionOwnershipRecord({ sharedRoot: root }, 'ordinary-disabled')?.state).toBe('active');
  });

  it('deduplicates roots shared by Direct and Docker runtimes', async () => {
    resolveSessionStorage({ sharedRoot: root }, 'shared-data', 'owner-a');
    const isProtected = vi.fn().mockReturnValue(false);
    const cleanup = provider({
      roots: [
        { runtimeId: 'direct-a', config: { sharedRoot: root } },
        { runtimeId: 'docker-a', config: { sharedRoot: root, mode: 'sqlite' } },
      ],
      isProtected,
    });

    const preview = await cleanup.preview(100);

    expect(preview).toHaveLength(1);
    expect(preview[0]).not.toHaveProperty('runtimeId');
    expect(isProtected).toHaveBeenCalledTimes(1);
  });

  it('requires two observations and the full grace period before deletion', async () => {
    resolveSessionStorage({ sharedRoot: root }, 'orphan-data', 'owner-a');
    writeFileSync(join(root, 'orphan-data', 'opencode.db'), 'persistent');
    const cleanup = provider();

    const first = await cleanup.run(1_000);
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: 'orphan-data', outcome: 'marked', state: 'pending' }),
    ]));
    expect(readSessionOwnershipRecord({ sharedRoot: root }, 'orphan-data')).toMatchObject({
      state: 'orphan-candidate',
      stateSince: 1_000,
    });
    expect(existsSync(join(root, 'orphan-data'))).toBe(true);

    const early = await cleanup.run(1_099);
    expect(early).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: 'orphan-data', outcome: 'skipped', state: 'pending' }),
    ]));

    const preview = await cleanup.preview(1_100);
    expect(preview).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: 'orphan-data', state: 'eligible' }),
    ]));
    expect(existsSync(join(root, 'orphan-data'))).toBe(true);

    const expired = await cleanup.run(1_100);
    expect(expired).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: 'orphan-data', outcome: 'deleted' }),
    ]));
    expect(existsSync(join(root, 'orphan-data'))).toBe(false);
    expect(readSessionOwnershipRecord({ sharedRoot: root }, 'orphan-data')).toBeUndefined();
  });

  it('enrolls pre-existing unmarked data without using filesystem age', async () => {
    resolveSessionStorage({ sharedRoot: root }, 'legacy-data');
    writeFileSync(join(root, 'legacy-data', 'old.db'), 'old');
    expect(readSessionOwnershipRecord({ sharedRoot: root }, 'legacy-data')).toBeUndefined();
    const cleanup = provider();

    const preview = await cleanup.preview(50_000);
    expect(preview).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: 'legacy-data', state: 'untracked', reason: 'untracked-session-data' }),
    ]));
    expect(readSessionOwnershipRecord({ sharedRoot: root }, 'legacy-data')).toBeUndefined();

    const first = await cleanup.run(50_000);
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: 'legacy-data', outcome: 'marked', firstObservedAt: 50_000 }),
    ]));
    expect(await cleanup.run(50_099)).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: 'legacy-data', outcome: 'skipped' }),
    ]));
    expect(existsSync(join(root, 'legacy-data'))).toBe(true);
  });

  it('clears an orphan candidate when ownership reappears', async () => {
    resolveSessionStorage({ sharedRoot: root }, 'restored-data', 'owner-a');
    const cleanup = provider();
    await cleanup.run(1_000);
    protectedIds.add('restored-data');

    const restored = await cleanup.run(1_050);

    expect(restored).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: 'restored-data', outcome: 'cleared' }),
    ]));
    expect(readSessionOwnershipRecord({ sharedRoot: root }, 'restored-data')?.state).toBe('active');
    expect(existsSync(join(root, 'restored-data'))).toBe(true);
  });

  it('retries delete-pending tombstones even when the id is protected', async () => {
    resolveSessionStorage({ sharedRoot: root }, 'pending-data', 'owner-a');
    markSessionStorageDeletePending({ sharedRoot: root }, 'pending-data', 'owner-a', 1_000);
    protectedIds.add('pending-data');

    const retried = await provider().run(1_001);

    expect(retried).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: 'pending-data', outcome: 'deleted', reason: 'delete-pending-retry' }),
    ]));
    expect(existsSync(join(root, 'pending-data'))).toBe(false);
  });

  it('retries delete-pending tombstones without consulting stale authority', async () => {
    resolveSessionStorage({ sharedRoot: root }, 'pending-unavailable', 'owner-a');
    markSessionStorageDeletePending({ sharedRoot: root }, 'pending-unavailable', 'owner-a', 1_000);
    const isProtected = vi.fn(() => { throw new Error('authority unavailable'); });

    const retried = await provider({ isProtected }).run(1_001);

    expect(retried).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: 'pending-unavailable', outcome: 'deleted' }),
    ]));
    expect(isProtected).not.toHaveBeenCalled();
  });

  it('never purges delete-pending data while its runtime is still active', async () => {
    resolveSessionStorage({ sharedRoot: root }, 'pending-runtime', 'owner-a');
    markSessionStorageDeletePending({ sharedRoot: root }, 'pending-runtime', 'owner-a', 1_000);

    const result = await provider({ isRuntimeActive: id => id === 'pending-runtime' }).run(1_001);

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({
        conversationId: 'pending-runtime',
        state: 'pending',
        reason: 'runtime-instance-present',
        outcome: 'skipped',
      }),
    ]));
    expect(existsSync(join(root, 'pending-runtime'))).toBe(true);
    expect(readSessionOwnershipRecord({ sharedRoot: root }, 'pending-runtime')?.state)
      .toBe('delete-pending');
  });

  it('reports foreign, malformed, invalid, and unsafe entries without mutating them', async () => {
    resolveSessionStorage({ sharedRoot: root }, 'foreign-data', 'owner-b');
    const layout = resolveSessionStorageLayout({ sharedRoot: root });
    writeFileSync(join(layout.recordsDir, 'broken-data.json'), '{not-json');
    mkdirSync(join(root, 'Invalid_Name'));
    writeFileSync(join(root, 'plain-file'), 'not a directory');
    const outside = mkdtempSync(join(tmpdir(), 'ao-local-target-'));
    let linked = false;
    try {
      symlinkSync(outside, join(root, 'linked-data'), 'junction');
      linked = true;
    } catch {
      // Some Windows environments disallow junction creation; other unsafe
      // entry assertions still exercise the non-mutating path.
    }

    try {
      const before = readFileSync(join(layout.recordsDir, 'broken-data.json'), 'utf8');
      const results = await provider().run(10_000);
      const reasons = results.map(item => item.reason);

      expect(reasons).toContain('foreign-owner');
      expect(reasons).toContain('malformed-ownership-record');
      expect(reasons).toContain('invalid-storage-entry');
      expect(reasons).toContain('unsafe-session-entry');
      if (linked) expect(reasons).toContain('unsafe-symbolic-link');
      expect(results.every(item => item.outcome === 'skipped')).toBe(true);
      expect(existsSync(join(root, 'foreign-data'))).toBe(true);
      expect(readFileSync(join(layout.recordsDir, 'broken-data.json'), 'utf8')).toBe(before);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('performs the final protection check under the lifecycle lock', async () => {
    resolveSessionStorage({ sharedRoot: root }, 'race-data', 'owner-a');
    const checks: boolean[] = [false, true];
    const lockedIds: string[] = [];
    const lock = async <T>(id: string, operation: () => Promise<T>): Promise<T> => {
      lockedIds.push(id);
      return operation();
    };
    const cleanup = provider({
      isProtected: () => checks.shift() ?? true,
      withConversationLock: lock,
    });

    const results = await cleanup.run(1_000);

    expect(lockedIds).toContain('race-data');
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: 'race-data', outcome: 'skipped' }),
    ]));
    expect(readSessionOwnershipRecord({ sharedRoot: root }, 'race-data')?.state).toBe('active');
  });

  it('skips deletion when the generation changes before the locked final check', async () => {
    const config = { sharedRoot: root };
    resolveSessionStorage(config, 'generation-data', 'owner-a');
    const cleanup = provider();
    await cleanup.run(1_000);
    const oldRecord = readSessionOwnershipRecord(config, 'generation-data')!;
    writeSessionOwnershipRecord(config, { ...oldRecord, stateSince: 0 });

    const recordPath = join(resolveSessionStorageLayout(config).recordsDir, 'generation-data.json');
    const lock = async <T>(_id: string, operation: () => Promise<T>): Promise<T> => {
      rmSync(recordPath);
      resolveSessionStorage(config, 'generation-data', 'owner-a');
      return operation();
    };
    const racingCleanup = provider({ withConversationLock: lock });

    const results = await racingCleanup.run(2_000);

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: 'generation-data', outcome: 'skipped' }),
    ]));
    expect(readSessionOwnershipRecord(config, 'generation-data')?.artifactId).not.toBe(oldRecord.artifactId);
    expect(existsSync(join(root, 'generation-data'))).toBe(true);
  });

  it('returns per-artifact failures while continuing safe artifacts', async () => {
    resolveSessionStorage({ sharedRoot: root }, 'good-data', 'owner-a');
    resolveSessionStorage({ sharedRoot: root }, 'check-fails', 'owner-a');
    const cleanup = provider({
      isProtected: (id) => {
        if (id === 'check-fails') throw new Error('backend unavailable');
        return false;
      },
    });

    const results = await cleanup.run(1_000);

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ conversationId: 'good-data', outcome: 'marked' }),
      expect.objectContaining({ conversationId: 'check-fails', outcome: 'failed', code: 'CLEANUP_FAILED' }),
    ]));
  });
});
