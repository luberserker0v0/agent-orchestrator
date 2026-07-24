import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceFactory } from './workspace-factory.js';
import { LocalStorage } from '../storage/index.js';

vi.mock('../metrics/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../metrics/registry.js')>();
  return {
    ...actual,
    workspacesActive: { inc: vi.fn(), dec: vi.fn(), set: vi.fn() },
    workspaceQuotaExceededTotal: { inc: vi.fn() },
  };
});

const TEST_BASE_PATH = join(process.cwd(), 'test-workspace');

function createFactory(config?: Partial<{ enforceCanonicalConfig: boolean; maxSizeBytes: number }>): WorkspaceFactory {
  const storage = new LocalStorage('test-workspace');
  return new WorkspaceFactory(
    {
      basePath: 'test-workspace',
      enforceCanonicalConfig: config?.enforceCanonicalConfig ?? true,
      maxSizeBytes: config?.maxSizeBytes,
      storage: { type: 'local' },
    },
    storage,
  );
}

function createFactoryWithCanonical(canonical: Record<string, unknown>): WorkspaceFactory {
  const storage = new LocalStorage('test-workspace');
  return new WorkspaceFactory(
    { basePath: 'test-workspace', enforceCanonicalConfig: true, storage: { type: 'local' } },
    storage,
    canonical,
  );
}

describe('WorkspaceFactory', () => {
  beforeEach(() => {
    if (existsSync(TEST_BASE_PATH)) {
      rmSync(TEST_BASE_PATH, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_BASE_PATH)) {
      rmSync(TEST_BASE_PATH, { recursive: true, force: true });
    }
  });

  it('should create workspace with specified id', async () => {
    const factory = createFactory();
    const info = await factory.create('conv-001');

    expect(existsSync(info.path)).toBe(true);
    expect(existsSync(info.opencodeDir)).toBe(true);
    expect(info.id).toBe('conv-001');
    expect(info.runtimeAccess).toEqual({ type: 'local', cwd: info.path });
  });

  it('should not write opencode.json on create', async () => {
    const factory = createFactory();
    await factory.create('conv-002');

    const configPath = join(TEST_BASE_PATH, 'conv-002', '.opencode', 'opencode.json');
    expect(existsSync(configPath)).toBe(false);
  });

  it('should sanitize id to prevent path traversal', async () => {
    const factory = createFactory();
    const info = await factory.create('../../../etc/passwd');

    expect(info.id).not.toContain('..');
    expect(info.id).not.toContain('/');
    expect(existsSync(info.path)).toBe(true);
  });

  it('should generate UUID when id is not provided', async () => {
    const factory = createFactory();
    const info = await factory.create();

    expect(info.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(existsSync(info.path)).toBe(true);
  });

  it('should not throw when creating existing workspace (recursive)', async () => {
    const factory = createFactory();
    await factory.create('conv-004');
    await expect(factory.create('conv-004')).resolves.not.toThrow();
  });

  it('should destroy workspace and remove files', async () => {
    const factory = createFactory();
    const info = await factory.create('conv-005');
    expect(existsSync(info.path)).toBe(true);

    await factory.destroy('conv-005');
    expect(existsSync(info.path)).toBe(false);
  });

  it('should not throw when destroying non-existent workspace', async () => {
    const factory = createFactory();
    await expect(factory.destroy('non-existent')).resolves.not.toThrow();
  });

  it('should ensure workspace directory exists without config', async () => {
    const factory = createFactory();
    const info = await factory.ensure('conv-ensure-no-config');
    expect(existsSync(info.path)).toBe(true);
    expect(existsSync(info.opencodeDir)).toBe(true);
    const configPath = join(info.opencodeDir, 'opencode.json');
    expect(existsSync(configPath)).toBe(false);
  });

  it('should report whether workspace exists', async () => {
    const factory = createFactory();
    expect(await factory.hasWorkspace('non-existent')).toBe(false);
    await factory.create('conv-exists');
    expect(await factory.hasWorkspace('conv-exists')).toBe(true);
  });

  it('should return 0 size for non-existent workspace', async () => {
    const factory = createFactory();
    expect(await factory.getWorkspaceSize('ghost')).toBe(0);
  });

  // ─── cleanupOrphans ──────────────────────────────────────

  describe('cleanupOrphans', () => {
    it('should remove all directories in basePath', async () => {
      const factory = createFactory();
      mkdirSync(join(TEST_BASE_PATH, 'orphan-1'), { recursive: true });
      mkdirSync(join(TEST_BASE_PATH, 'orphan-2'), { recursive: true });
      expect(existsSync(join(TEST_BASE_PATH, 'orphan-1'))).toBe(true);

      await factory.cleanupOrphans();

      expect(existsSync(join(TEST_BASE_PATH, 'orphan-1'))).toBe(false);
      expect(existsSync(join(TEST_BASE_PATH, 'orphan-2'))).toBe(false);
    });

    it('should not throw when basePath is empty', async () => {
      const factory = createFactory();
      await expect(factory.cleanupOrphans()).resolves.not.toThrow();
    });

    it('should not throw when basePath does not exist', async () => {
      const storage = new LocalStorage('nonexistent-workspace');
      const factory = new WorkspaceFactory(
        { basePath: 'nonexistent-workspace', enforceCanonicalConfig: true, storage: { type: 'local' } },
        storage,
      );
      await expect(factory.cleanupOrphans()).resolves.not.toThrow();
    });

    it('should not affect files outside basePath', async () => {
      const factory = createFactory();
      const outsidePath = join(process.cwd(), 'outside-test-file.txt');
      writeFileSync(outsidePath, 'should not be deleted');
      mkdirSync(join(TEST_BASE_PATH, 'orphan-inside'), { recursive: true });

      await factory.cleanupOrphans();

      expect(existsSync(outsidePath)).toBe(true);
      rmSync(outsidePath, { force: true });
    });

    it('should handle errors gracefully', async () => {
      const factory = createFactory();
      mkdirSync(join(TEST_BASE_PATH, 'orphan-a'), { recursive: true });
      mkdirSync(join(TEST_BASE_PATH, 'orphan-b'), { recursive: true });

      await expect(factory.cleanupOrphans()).resolves.not.toThrow();
      expect(existsSync(join(TEST_BASE_PATH, 'orphan-a'))).toBe(false);
      expect(existsSync(join(TEST_BASE_PATH, 'orphan-b'))).toBe(false);
    });
  });

  // ─── Config ──────────────────────────────────────────────

  describe('writeConfig / readConfig', () => {
    it('should allow setting non-canonical keys when enforce=true', async () => {
      const factory = createFactoryWithCanonical({ $schema: 'https://opencode.ai/config.json' });
      await factory.create('conv-config');
      await factory.writeConfig('conv-config', { model: 'gpt-4', customKey: 'value' as unknown as undefined });

      const config = await factory.readConfig('conv-config');
      expect(config.$schema).toBe('https://opencode.ai/config.json');
      expect(config.model).toBe('gpt-4');
      expect((config as unknown as Record<string, unknown>).customKey).toBe('value');
    });

    it('should protect canonical keys when enforce=true', async () => {
      const factory = createFactoryWithCanonical({ $schema: 'https://opencode.ai/config.json', permission: { bash: 'deny' } });
      await factory.create('conv-config-protect');
      await factory.writeConfig('conv-config-protect', { permission: { bash: 'allow' }, model: 'gpt-4' });

      const config = await factory.readConfig('conv-config-protect');
      expect(config.permission).toEqual({ bash: 'deny' });
      expect(config.model).toBe('gpt-4');
    });

    it('should write verbatim when enforce=false', async () => {
      const storage = new LocalStorage('test-workspace');
      const factory = new WorkspaceFactory(
        { basePath: 'test-workspace', enforceCanonicalConfig: false, storage: { type: 'local' } },
        storage,
      );
      await factory.create('conv-config-free');
      await factory.writeConfig('conv-config-free', { model: 'gpt-4', permission: { bash: 'allow' } });

      const config = await factory.readConfig('conv-config-free');
      expect(config.model).toBe('gpt-4');
      expect(config.permission).toEqual({ bash: 'allow' });
    });

    it('should return empty object when config does not exist', async () => {
      const factory = createFactory();
      await factory.ensure('conv-config2');

      expect(await factory.readConfig('conv-config2')).toEqual({});
    });
  });

  describe('file CRUD', () => {
    it('should write and read files', async () => {
      const factory = createFactory();
      await factory.create('conv-file');
      await factory.writeFile('conv-file', 'templates/design-spec.md', '# Design Spec');

      const content = await factory.readFile('conv-file', 'templates/design-spec.md');
      expect(content).toBe('# Design Spec');
    });

    it('should list files', async () => {
      const factory = createFactory();
      await factory.create('conv-file-list');

      await factory.writeFile('conv-file-list', 'a.md', 'a');
      await factory.writeFile('conv-file-list', 'b.md', 'b');

      const files = await factory.listFiles('conv-file-list');
      expect(files).toContain('a.md');
      expect(files).toContain('b.md');
    });

    it('should delete files', async () => {
      const factory = createFactory();
      await factory.create('conv-file-del');

      await factory.writeFile('conv-file-del', 'temp.txt', 'temp');
      await factory.deleteFile('conv-file-del', 'temp.txt');
      await expect(factory.readFile('conv-file-del', 'temp.txt')).rejects.toThrow();
    });

    it('should block path traversal in file operations', async () => {
      const factory = createFactory();
      await factory.create('conv-sec');

      await expect(factory.writeFile('conv-sec', '../outside.txt', 'bad')).rejects.toThrow('path traversal');
      await expect(factory.readFile('conv-sec', '../outside.txt')).rejects.toThrow('path traversal');
    });

    it('should block absolute paths', async () => {
      const factory = createFactory();
      await factory.create('conv-sec2');

      await expect(factory.writeFile('conv-sec2', '/etc/passwd', 'bad')).rejects.toThrow('absolute paths');
    });

    it('should block backslash-based path traversal', async () => {
      const factory = createFactory();
      await factory.create('conv-sec3');

      await expect(factory.writeFile('conv-sec3', '..\\..\\outside.txt', 'bad')).rejects.toThrow('path traversal');
    });

    it('should throw when reading non-existent file', async () => {
      const factory = createFactory();
      await factory.create('conv-read-miss');

      await expect(factory.readFile('conv-read-miss', 'no-such-file.txt')).rejects.toThrow();
    });

    it('should throw when listing files in non-existent subdirectory', async () => {
      const factory = createFactory();
      await factory.create('conv-list-miss');

      await expect(factory.listFiles('conv-list-miss', 'no-such-dir')).rejects.toThrow();
    });

    it('should delete directory recursively', async () => {
      const factory = createFactory();
      await factory.create('conv-dir-del');

      await factory.writeFile('conv-dir-del', 'subdir/test.txt', 'test content');
      expect(existsSync(join(TEST_BASE_PATH, 'conv-dir-del', 'subdir'))).toBe(true);

      await factory.deleteFile('conv-dir-del', 'subdir');
      expect(existsSync(join(TEST_BASE_PATH, 'conv-dir-del', 'subdir'))).toBe(false);
    });

    it('should throw when deleting non-existent file', async () => {
      const factory = createFactory();
      await factory.create('conv-del-miss');

      await expect(factory.deleteFile('conv-del-miss', 'ghost.txt')).rejects.toThrow();
    });
  });

  // ─── copyFromLocal ───────────────────────────────────────

  describe('copyFromLocal', () => {
    beforeEach(() => {
      const assetsDir = join(process.cwd(), 'assets');
      const templatesDir = join(process.cwd(), 'templates');
      mkdirSync(assetsDir, { recursive: true });
      mkdirSync(templatesDir, { recursive: true });

      writeFileSync(join(assetsDir, 'template.md'), '# Template', 'utf-8');
      writeFileSync(join(templatesDir, 'guide.txt'), 'Guide content', 'utf-8');
    });

    afterEach(() => {
      const assetsDir = join(process.cwd(), 'assets');
      const templatesDir = join(process.cwd(), 'templates');
      if (existsSync(assetsDir)) rmSync(assetsDir, { recursive: true, force: true });
      if (existsSync(templatesDir)) rmSync(templatesDir, { recursive: true, force: true });
    });

    it('should copy file from allowed source', async () => {
      const factory = createFactory();
      await factory.create('conv-copy');

      await factory.copyFromLocal('conv-copy', join('assets', 'template.md'), 'templates/template.md');
      const content = await factory.readFile('conv-copy', 'templates/template.md');
      expect(content).toBe('# Template');
    });

    it('should reject copy from disallowed source', async () => {
      const factory = createFactory();
      await factory.create('conv-copy-denied');

      await expect(
        factory.copyFromLocal('conv-copy-denied', join('..', 'outside.txt'), 'outside.txt')
      ).rejects.toThrow('Source path not allowed');
    });

    it('should throw when copy source not found', async () => {
      const factory = createFactory();
      await factory.create('conv-copy-no-src');

      await expect(
        factory.copyFromLocal('conv-copy-no-src', join('assets', 'ghost.txt'), 'ghost.txt')
      ).rejects.toThrow('Source not found');
    });

    it('should reject copy from sibling prefix path skills_evil/', async () => {
      const factory = createFactory();
      await factory.create('conv-copy-prefix-evil');

      await expect(
        factory.copyFromLocal('conv-copy-prefix-evil', join('skills_evil', 'malicious.txt'), 'malicious.txt')
      ).rejects.toThrow('Source path not allowed');
    });

    it('should reject copy from sibling prefix path templates_backup/', async () => {
      const factory = createFactory();
      await factory.create('conv-copy-prefix-bak');

      await expect(
        factory.copyFromLocal('conv-copy-prefix-bak', join('templates_backup', 'old.txt'), 'old.txt')
      ).rejects.toThrow('Source path not allowed');
    });
  });

  // ─── Quota ───────────────────────────────────────────────

  describe('quota', () => {
    it('should enforce 50MB workspace size limit', async () => {
      const factory = createFactory({ maxSizeBytes: 50 * 1024 * 1024 });
      await factory.create('conv-quota');

      const bigContent = 'x'.repeat(51 * 1024 * 1024);

      await expect(factory.writeFile('conv-quota', 'big.txt', bigContent)).rejects.toThrow('quota exceeded');
    });

    it('should calculate workspace size', async () => {
      const factory = createFactory();
      await factory.create('conv-size');
      await factory.writeFile('conv-size', 'test.txt', 'hello');

      expect(await factory.getWorkspaceSize('conv-size')).toBeGreaterThan(0);
    });

    it('should return configured maxSizeBytes via getMaxSizeBytes', () => {
      const factory = createFactory({ maxSizeBytes: 100 * 1024 * 1024 });
      expect(factory.getMaxSizeBytes()).toBe(100 * 1024 * 1024);
    });

    it('should return default 50MB when maxSizeBytes is not configured', () => {
      const factory = createFactory();
      expect(factory.getMaxSizeBytes()).toBe(50 * 1024 * 1024);
    });

    it('should skip quota check when maxSizeBytes is 0 (unlimited)', async () => {
      const factory = createFactory({ maxSizeBytes: 0 });
      await factory.create('conv-unlimited');

      const bigContent = 'x'.repeat(51 * 1024 * 1024);
      await expect(factory.writeFile('conv-unlimited', 'big.txt', bigContent)).resolves.not.toThrow();
    });
  });
});
