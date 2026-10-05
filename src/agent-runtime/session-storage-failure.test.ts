import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const failure = vi.hoisted(() => ({ purgeQuarantine: false }));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    rmSync: (
      path: import('node:fs').PathLike,
      options?: { force?: boolean; recursive?: boolean },
    ) => {
      if (
        failure.purgeQuarantine
        && options?.recursive === true
        && String(path).includes(`${actual.realpathSync.native(process.cwd()).includes('\\') ? '\\' : '/'}quarantine`)
      ) {
        throw Object.assign(new Error('simulated purge failure'), { code: 'EACCES' });
      }
      actual.rmSync(path, options);
    },
  };
});

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPersistentDataProvider } from '../cleanup/local-persistent-data-provider.js';
import { ErrorCodes } from '../utils/errors.js';
import {
  deleteManagedSessionStorage,
  markSessionStorageDeletePending,
  readSessionOwnershipRecord,
  resolveSessionStorage,
  sessionQuarantinePath,
} from './session-storage.js';

describe('persistent session purge recovery', () => {
  let root: string;

  beforeEach(() => {
    failure.purgeQuarantine = false;
    root = mkdtempSync(join(tmpdir(), 'ao-session-purge-failure-'));
  });

  afterEach(() => {
    failure.purgeQuarantine = false;
    rmSync(root, { recursive: true, force: true });
  });

  it('retains a tombstone after purge failure and retries that quarantined generation', async () => {
    const config = { sharedRoot: root };
    const resolved = resolveSessionStorage(config, 'conv-retry', 'owner-a');
    writeFileSync(join(resolved.sessionDir, 'opencode.db'), 'session data');
    const artifactId = markSessionStorageDeletePending(config, 'conv-retry', 'owner-a')!;

    failure.purgeQuarantine = true;
    await expect(deleteManagedSessionStorage(config, 'conv-retry', 'owner-a', artifactId))
      .rejects.toMatchObject({ code: ErrorCodes.PERSISTENT_DATA_CLEANUP_PENDING });

    expect(existsSync(resolved.sessionDir)).toBe(false);
    expect(existsSync(sessionQuarantinePath(config, artifactId))).toBe(true);
    expect(readSessionOwnershipRecord(config, 'conv-retry')).toMatchObject({
      artifactId,
      state: 'delete-pending',
    });
    expect(() => resolveSessionStorage(config, 'conv-retry', 'owner-a'))
      .toThrow(expect.objectContaining({ code: ErrorCodes.PERSISTENT_DATA_CLEANUP_PENDING }));

    failure.purgeQuarantine = false;
    const provider = new LocalPersistentDataProvider({
      enabled: false,
      retryPendingDeletes: true,
      ownerId: 'owner-a',
      gracePeriodMs: 30 * 24 * 60 * 60 * 1000,
      roots: [{ runtimeId: 'direct', config }],
      isProtected: () => {
        throw new Error('delete-pending retry must not consult stale authority');
      },
    });

    expect(await provider.run(Date.now())).toEqual([
      expect.objectContaining({ artifactId, outcome: 'deleted' }),
    ]);
    expect(existsSync(sessionQuarantinePath(config, artifactId))).toBe(false);
    expect(readSessionOwnershipRecord(config, 'conv-retry')).toBeUndefined();
  });
});
