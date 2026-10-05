import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import {
  deleteManagedSessionStorage,
  markSessionStorageDeletePending,
  readSessionOwnershipRecord,
  resolveSessionStorage,
  resolveSessionStorageLayout,
  sanitizeSessionId,
  sessionQuarantinePath,
  writeSessionOwnershipRecord,
} from './session-storage.js';
import { ErrorCodes } from '../utils/errors.js';

describe('sanitizeSessionId', () => {
  it('replaces path separators', () => {
    expect(sanitizeSessionId('a/b\\c')).toBe('a_b_c');
  });

  it('collapses dot-dot sequences', () => {
    expect(sanitizeSessionId('../evil')).toBe('__evil');
  });

  it('leaves plain ids untouched', () => {
    expect(sanitizeSessionId('conv-123')).toBe('conv-123');
  });
});

describe('resolveSessionStorage', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ao-session-storage-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates per-conversation dir and maps XDG_DATA_HOME in xdg mode', () => {
    const config = { sharedRoot: root };
    const result = resolveSessionStorage(config, 'conv-1');
    expect(result.sessionDir).toBe(join(resolve(root), 'conv-1'));
    expect(existsSync(result.sessionDir)).toBe(true);
    expect(result.env).toEqual({ XDG_DATA_HOME: result.sessionDir });
    expect(result.artifactId).toBeUndefined();
    expect(readSessionOwnershipRecord(config, 'conv-1')).toBeUndefined();
    expect(existsSync(resolveSessionStorageLayout(config).controlDir)).toBe(false);
  });

  it('adds OPENCODE_DB in sqlite mode', () => {
    const result = resolveSessionStorage({ sharedRoot: root, mode: 'sqlite' }, 'conv-2');
    expect(result.env).toEqual({
      XDG_DATA_HOME: result.sessionDir,
      OPENCODE_DB: join(result.sessionDir, 'opencode.db'),
    });
  });

  it('sanitizes hostile conversation ids', () => {
    const result = resolveSessionStorage({ sharedRoot: root }, '../../evil');
    expect(result.sessionDir).toBe(join(resolve(root), '____evil'));
    expect(existsSync(result.sessionDir)).toBe(true);
  });

  it('resolves relative roots against cwd', () => {
    const result = resolveSessionStorage({ sharedRoot: 'relative-root-test' }, 'conv-3');
    expect(result.sessionDir).toBe(join(resolve(process.cwd(), 'relative-root-test'), 'conv-3'));
    rmSync(join(resolve(process.cwd(), 'relative-root-test')), { recursive: true, force: true });
  });

  it('creates and reuses an immutable ownership generation for canonical ids', () => {
    const first = resolveSessionStorage({ sharedRoot: root }, 'conv-owned', 'owner-a');
    const firstRecord = readSessionOwnershipRecord({ sharedRoot: root }, 'conv-owned');

    expect(first.artifactId).toBe(firstRecord?.artifactId);
    expect(firstRecord).toMatchObject({
      version: 1,
      conversationId: 'conv-owned',
      ownerId: 'owner-a',
      state: 'active',
    });

    const second = resolveSessionStorage({ sharedRoot: root }, 'conv-owned', 'owner-a');
    expect(second.artifactId).toBe(first.artifactId);
  });

  it('blocks startup while an earlier generation is delete-pending', () => {
    resolveSessionStorage({ sharedRoot: root }, 'conv-pending', 'owner-a');
    markSessionStorageDeletePending({ sharedRoot: root }, 'conv-pending', 'owner-a', 1234);

    expect(() => resolveSessionStorage({ sharedRoot: root }, 'conv-pending', 'owner-a'))
      .toThrow(expect.objectContaining({ code: ErrorCodes.PERSISTENT_DATA_CLEANUP_PENDING }));
  });

  it('quarantines and purges managed data after explicit deletion', async () => {
    const config = { sharedRoot: root };
    const resolved = resolveSessionStorage(config, 'conv-delete', 'owner-a');
    writeFileSync(join(resolved.sessionDir, 'opencode.db'), 'session data');
    const artifactId = markSessionStorageDeletePending(config, 'conv-delete', 'owner-a');

    await deleteManagedSessionStorage(config, 'conv-delete', 'owner-a', artifactId);

    expect(existsSync(resolved.sessionDir)).toBe(false);
    expect(existsSync(sessionQuarantinePath(config, artifactId!))).toBe(false);
    expect(readSessionOwnershipRecord(config, 'conv-delete')).toBeUndefined();
  });

  it('does not let a stale cleanup delete a new same-id generation', async () => {
    const config = { sharedRoot: root };
    const first = resolveSessionStorage(config, 'conv-reused', 'owner-a');
    const oldArtifactId = markSessionStorageDeletePending(config, 'conv-reused', 'owner-a');
    await deleteManagedSessionStorage(config, 'conv-reused', 'owner-a', oldArtifactId);
    const second = resolveSessionStorage(config, 'conv-reused', 'owner-a');
    writeFileSync(join(second.sessionDir, 'keep.txt'), 'new generation');

    await deleteManagedSessionStorage(config, 'conv-reused', 'owner-a', first.artifactId);

    expect(existsSync(join(second.sessionDir, 'keep.txt'))).toBe(true);
    expect(readSessionOwnershipRecord(config, 'conv-reused')?.artifactId).toBe(second.artifactId);
  });

  it('keeps an unowned same-id generation safe from a stale explicit delete', async () => {
    const config = { sharedRoot: root };
    const first = resolveSessionStorage(config, 'conv-unowned-reused');
    expect(first.artifactId).toBeUndefined();

    const oldArtifactId = markSessionStorageDeletePending(config, 'conv-unowned-reused');
    await deleteManagedSessionStorage(config, 'conv-unowned-reused', undefined, oldArtifactId);

    const second = resolveSessionStorage(config, 'conv-unowned-reused');
    writeFileSync(join(second.sessionDir, 'keep.txt'), 'new generation');
    await deleteManagedSessionStorage(config, 'conv-unowned-reused', undefined, oldArtifactId);

    expect(existsSync(join(second.sessionDir, 'keep.txt'))).toBe(true);
    expect(readSessionOwnershipRecord(config, 'conv-unowned-reused')).toBeUndefined();
  });

  it('refuses ownership takeover and artifact-id mutation', () => {
    resolveSessionStorage({ sharedRoot: root }, 'conv-owner', 'owner-a');
    expect(() => resolveSessionStorage({ sharedRoot: root }, 'conv-owner', 'owner-b'))
      .toThrow('owned by another orchestrator');

    const record = readSessionOwnershipRecord({ sharedRoot: root }, 'conv-owner')!;
    expect(() => writeSessionOwnershipRecord({ sharedRoot: root }, {
      ...record,
      artifactId: '00000000-0000-4000-8000-000000000000',
    })).toThrow('immutable');
  });

  it('leaves non-canonical legacy directories untracked', () => {
    const result = resolveSessionStorage({ sharedRoot: root }, '../../evil');
    const layout = resolveSessionStorageLayout({ sharedRoot: root });
    expect(result.artifactId).toBeUndefined();
    expect(existsSync(layout.recordsDir)).toBe(false);
  });

  it('rejects filesystem roots and keeps pending generations blocked', () => {
    expect(() => resolveSessionStorageLayout({ sharedRoot: parse(root).root }))
      .toThrow('cannot be a filesystem root');

    const config = { sharedRoot: root };
    resolveSessionStorage(config, 'conv-unsafe', 'owner-a');
    const artifactId = markSessionStorageDeletePending(config, 'conv-unsafe', 'owner-a')!;
    const quarantine = sessionQuarantinePath(config, artifactId);
    mkdirSync(quarantine);
    writeFileSync(join(quarantine, 'marker'), 'existing');
    expect(() => resolveSessionStorage(config, 'conv-unsafe', 'owner-a'))
      .toThrow(expect.objectContaining({ code: ErrorCodes.PERSISTENT_DATA_CLEANUP_PENDING }));
  });
});
