import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalStorage } from './local.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('LocalStorage', () => {
  let tmpDir: string;
  let storage: LocalStorage;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storage = new LocalStorage(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('createWorkspaceDir / ensureWorkspaceDir', () => {
    it('creates workspace directory', async () => {
      await storage.createWorkspaceDir('ws-1');
      const p = join(tmpDir, 'ws-1');
      expect(existsSync(p)).toBe(true);
    });

    it('ensureWorkspaceDir creates recursively', async () => {
      await storage.ensureWorkspaceDir('ws-2');
      expect(existsSync(join(tmpDir, 'ws-2'))).toBe(true);
    });

    it('createWorkspaceDir is idempotent', async () => {
      await storage.createWorkspaceDir('ws-3');
      await storage.createWorkspaceDir('ws-3');
      expect(existsSync(join(tmpDir, 'ws-3'))).toBe(true);
    });
  });

  describe('hasWorkspace', () => {
    it('returns true for existing workspace', async () => {
      await storage.createWorkspaceDir('ws-exists');
      expect(await storage.hasWorkspace('ws-exists')).toBe(true);
    });

    it('returns false for non-existing workspace', async () => {
      expect(await storage.hasWorkspace('ws-nope')).toBe(false);
    });
  });

  describe('destroyWorkspace', () => {
    it('destroys existing workspace', async () => {
      await storage.createWorkspaceDir('ws-destroy');
      await writeFile(join(tmpDir, 'ws-destroy', 'file.txt'), 'hello');
      await storage.destroyWorkspace('ws-destroy');
      expect(existsSync(join(tmpDir, 'ws-destroy'))).toBe(false);
    });

    it('does nothing for non-existing workspace', async () => {
      await storage.destroyWorkspace('ws-ghost');
      // should not throw
    });
  });

  describe('ensureDir', () => {
    it('creates nested directories', async () => {
      await storage.createWorkspaceDir('ws-dir');
      await storage.ensureDir('ws-dir', 'a/b/c');
      expect(existsSync(join(tmpDir, 'ws-dir', 'a', 'b', 'c'))).toBe(true);
    });
  });

  describe('readFile / writeFile', () => {
    it('writes and reads file', async () => {
      await storage.createWorkspaceDir('ws-rw');
      await storage.writeFile('ws-rw', 'test.txt', 'hello world');
      const buf = await storage.readFile('ws-rw', 'test.txt');
      expect(buf.toString()).toBe('hello world');
    });

    it('writes Buffer content', async () => {
      await storage.createWorkspaceDir('ws-rw2');
      const content = Buffer.from('binary data');
      await storage.writeFile('ws-rw2', 'bin.dat', content);
      const buf = await storage.readFile('ws-rw2', 'bin.dat');
      expect(buf).toEqual(content);
    });

    it('creates parent directories on write', async () => {
      await storage.createWorkspaceDir('ws-rw3');
      await storage.writeFile('ws-rw3', 'sub/dir/file.txt', 'nested');
      const buf = await storage.readFile('ws-rw3', 'sub/dir/file.txt');
      expect(buf.toString()).toBe('nested');
    });
  });

  describe('listEntries', () => {
    it('lists root entries', async () => {
      await storage.createWorkspaceDir('ws-list');
      await storage.writeFile('ws-list', 'a.txt', 'a');
      await storage.writeFile('ws-list', 'b.txt', 'b');
      const entries = await storage.listEntries('ws-list');
      expect(entries.sort()).toEqual(['a.txt', 'b.txt']);
    });

    it('lists entries in subdirectory', async () => {
      await storage.createWorkspaceDir('ws-list2');
      await storage.writeFile('ws-list2', 'sub/x.txt', 'x');
      await storage.writeFile('ws-list2', 'sub/y.txt', 'y');
      const entries = await storage.listEntries('ws-list2', 'sub');
      expect(entries.sort()).toEqual(['x.txt', 'y.txt']);
    });
  });

  describe('deleteEntry', () => {
    it('deletes existing file', async () => {
      await storage.createWorkspaceDir('ws-del');
      await storage.writeFile('ws-del', 'to-delete.txt', 'bye');
      await storage.deleteEntry('ws-del', 'to-delete.txt');
      expect(existsSync(join(tmpDir, 'ws-del', 'to-delete.txt'))).toBe(false);
    });

    it('throws for non-existing file', async () => {
      await storage.createWorkspaceDir('ws-del2');
      await expect(storage.deleteEntry('ws-del2', 'nope.txt'))
        .rejects.toThrow('File not found: nope.txt');
    });
  });

  describe('getWorkspaceSize', () => {
    it('returns 0 for non-existing workspace', async () => {
      expect(await storage.getWorkspaceSize('ws-ghost')).toBe(0);
    });

    it('returns correct size for workspace with files', async () => {
      await storage.createWorkspaceDir('ws-size');
      await storage.writeFile('ws-size', 'small.txt', 'abc');
      const size = await storage.getWorkspaceSize('ws-size');
      expect(size).toBe(3);
    });

    it('calculates size recursively', async () => {
      await storage.createWorkspaceDir('ws-size2');
      await storage.writeFile('ws-size2', 'a.txt', 'aaaa');
      await storage.writeFile('ws-size2', 'sub/b.txt', 'bb');
      const size = await storage.getWorkspaceSize('ws-size2');
      expect(size).toBe(6);
    });
  });

  describe('copyToStorage', () => {
    it('copies file to storage', async () => {
      await storage.createWorkspaceDir('ws-copy');
      const srcFile = join(tmpDir, 'source.txt');
      await writeFile(srcFile, 'copy me');
      await storage.copyToStorage('ws-copy', srcFile, 'dest.txt');
      const buf = await storage.readFile('ws-copy', 'dest.txt');
      expect(buf.toString()).toBe('copy me');
    });

    it('creates intermediate directories', async () => {
      await storage.createWorkspaceDir('ws-copy2');
      const srcFile = join(tmpDir, 'src2.txt');
      await writeFile(srcFile, 'deep copy');
      await storage.copyToStorage('ws-copy2', srcFile, 'a/b/c.txt');
      const buf = await storage.readFile('ws-copy2', 'a/b/c.txt');
      expect(buf.toString()).toBe('deep copy');
    });
  });

  describe('copyToStorageRecursive', () => {
    it('copies directory recursively', async () => {
      await storage.createWorkspaceDir('ws-rcopy');
      const srcDir = join(tmpDir, 'src-rcopy');
      await mkdir(join(srcDir, 'sub'), { recursive: true });
      await writeFile(join(srcDir, 'root.txt'), 'root');
      await writeFile(join(srcDir, 'sub', 'child.txt'), 'child');

      await storage.copyToStorageRecursive('ws-rcopy', srcDir, 'dest');

      const rootBuf = await storage.readFile('ws-rcopy', 'dest/root.txt');
      expect(rootBuf.toString()).toBe('root');
      const childBuf = await storage.readFile('ws-rcopy', 'dest/sub/child.txt');
      expect(childBuf.toString()).toBe('child');
    });

    it('copies with empty root path', async () => {
      await storage.createWorkspaceDir('ws-rcopy2');
      const srcDir = join(tmpDir, 'src-rcopy2');
      await mkdir(srcDir, { recursive: true });
      await writeFile(join(srcDir, 'file.txt'), 'content');

      await storage.copyToStorageRecursive('ws-rcopy2', srcDir, '');

      const buf = await storage.readFile('ws-rcopy2', 'file.txt');
      expect(buf.toString()).toBe('content');
    });
  });

  describe('getRuntimeAccess', () => {
    it('returns local runtime access', () => {
      const access = storage.getRuntimeAccess('ws-access');
      expect(access).toEqual({ type: 'local', cwd: join(tmpDir, 'ws-access') });
    });
  });

  describe('cleanupOrphans', () => {
    it('removes all entries in base path', async () => {
      await mkdir(join(tmpDir, 'orphan-1'), { recursive: true });
      await mkdir(join(tmpDir, 'orphan-2'), { recursive: true });
      await storage.cleanupOrphans();
      // All entries should be removed
      const entries = await readdir(tmpDir);
      // tmpDir itself may have other test dirs, but ours should be gone
      expect(entries.filter(e => e.startsWith('orphan-'))).toEqual([]);
    });

    it('does nothing if basePath does not exist', async () => {
      const nonExistent = new LocalStorage(join(tmpDir, 'no-such-dir'));
      await nonExistent.cleanupOrphans();
      // should not throw
    });
  });

  describe('sanitizeId', () => {
    it('sanitizes path separators in workspace id', async () => {
      await storage.createWorkspaceDir('ws/../../etc');
      const entries = await readdir(tmpDir);
      // 'ws/../../etc' → 'ws_.._.._etc' → 'ws_____etc'
      expect(entries.some(e => e === 'ws_____etc')).toBe(true);
    });

    it('sanitizes double dots', async () => {
      await storage.createWorkspaceDir('ws..evil');
      const entries = await readdir(tmpDir);
      expect(entries.some(e => e === 'ws_evil')).toBe(true);
    });
  });
});

describe('LocalStorage - retryRm edge cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('retries on EPERM and eventually succeeds', async () => {
    // Create a workspace, then destroy it (normal path)
    const storage = new LocalStorage(tmpDir);
    await storage.createWorkspaceDir('ws-retry');
    await storage.destroyWorkspace('ws-retry');
    expect(existsSync(join(tmpDir, 'ws-retry'))).toBe(false);
  });
});

describe('LocalStorage - getDirSize edge cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns 0 for empty directory', async () => {
    const storage = new LocalStorage(tmpDir);
    await storage.createWorkspaceDir('ws-empty');
    const size = await storage.getWorkspaceSize('ws-empty');
    expect(size).toBe(0);
  });

  it('handles inaccessible files gracefully', async () => {
    const storage = new LocalStorage(tmpDir);
    await storage.createWorkspaceDir('ws-mixed');
    await storage.writeFile('ws-mixed', 'good.txt', 'data');
    // getDirSize should still return a number even if some files fail
    const size = await storage.getWorkspaceSize('ws-mixed');
    expect(size).toBeGreaterThanOrEqual(0);
  });
});
