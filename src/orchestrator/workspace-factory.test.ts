import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceFactory } from './workspace-factory.js';

const TEST_BASE_PATH = join(process.cwd(), 'test-workspace');

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

  it('should create workspace with specified id', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      enforceCanonicalConfig: true,
    });

    const info = factory.create('conv-001');

    expect(existsSync(info.path)).toBe(true);
    expect(existsSync(info.opencodeDir)).toBe(true);
    expect(info.id).toBe('conv-001');
  });

  it('should not write opencode.json on create', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      enforceCanonicalConfig: true,
    });

    factory.create('conv-002');

    const configPath = join(TEST_BASE_PATH, 'conv-002', '.opencode', 'opencode.json');
    expect(existsSync(configPath)).toBe(false);
  });

  it('should sanitize id to prevent path traversal', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      enforceCanonicalConfig: true,
    });

    const info = factory.create('../../../etc/passwd');

    // The id should be sanitized, not the original path
    expect(info.id).not.toContain('..');
    expect(info.id).not.toContain('/');
    expect(existsSync(info.path)).toBe(true);
  });

  it('should generate UUID when id is not provided', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      enforceCanonicalConfig: true,
    });

    const info = factory.create();

    // UUID format validation (rough)
    expect(info.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(existsSync(info.path)).toBe(true);
  });

  it('should not throw when creating existing workspace (recursive)', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      enforceCanonicalConfig: true,
    });

    factory.create('conv-004');
    // Second creation should not throw because mkdirSync uses recursive: true
    expect(() => factory.create('conv-004')).not.toThrow();
  });

  it('should destroy workspace and remove files', async () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      enforceCanonicalConfig: true,
    });

    const info = factory.create('conv-005');
    expect(existsSync(info.path)).toBe(true);

    await factory.destroy('conv-005');
    expect(existsSync(info.path)).toBe(false);
  });

  it('should not throw when destroying non-existent workspace', async () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      enforceCanonicalConfig: true,
    });

    await expect(factory.destroy('non-existent')).resolves.not.toThrow();
  });

  it('should ensure workspace directory exists without config', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      enforceCanonicalConfig: true,
    });

    const info = factory.ensure('conv-ensure-no-config');
    expect(existsSync(info.path)).toBe(true);
    expect(existsSync(info.opencodeDir)).toBe(true);
    // Config should NOT be written by ensure()
    const configPath = join(info.opencodeDir, 'opencode.json');
    expect(existsSync(configPath)).toBe(false);
  });

  it('should report whether workspace exists', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      enforceCanonicalConfig: true,
    });

    expect(factory.hasWorkspace('non-existent')).toBe(false);
    factory.create('conv-exists');
    expect(factory.hasWorkspace('conv-exists')).toBe(true);
  });

  it('should return 0 size for non-existent workspace', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      enforceCanonicalConfig: true,
    });

    expect(factory.getWorkspaceSize('ghost')).toBe(0);
  });

  // ─── cleanupOrphans ──────────────────────────────────────

  describe('cleanupOrphans', () => {
    it('should remove all directories in basePath', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });

      mkdirSync(join(TEST_BASE_PATH, 'orphan-1'), { recursive: true });
      mkdirSync(join(TEST_BASE_PATH, 'orphan-2'), { recursive: true });
      expect(existsSync(join(TEST_BASE_PATH, 'orphan-1'))).toBe(true);

      factory.cleanupOrphans();

      expect(existsSync(join(TEST_BASE_PATH, 'orphan-1'))).toBe(false);
      expect(existsSync(join(TEST_BASE_PATH, 'orphan-2'))).toBe(false);
    });

    it('should not throw when basePath is empty', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });

      expect(() => factory.cleanupOrphans()).not.toThrow();
    });

    it('should not throw when basePath does not exist', () => {
      const factory = new WorkspaceFactory({
        basePath: 'nonexistent-workspace',
        enforceCanonicalConfig: true,
      });

      expect(() => factory.cleanupOrphans()).not.toThrow();
    });

    it('should not affect files outside basePath', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });

      const outsidePath = join(process.cwd(), 'outside-test-file.txt');
      writeFileSync(outsidePath, 'should not be deleted');
      mkdirSync(join(TEST_BASE_PATH, 'orphan-inside'), { recursive: true });

      factory.cleanupOrphans();

      expect(existsSync(outsidePath)).toBe(true);
      rmSync(outsidePath, { force: true });
    });

    it('should handle errors gracefully', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });

      mkdirSync(join(TEST_BASE_PATH, 'orphan-a'), { recursive: true });
      mkdirSync(join(TEST_BASE_PATH, 'orphan-b'), { recursive: true });

      // Simulate a read-only scenario: create a file and make it unwritable
      // On Windows this approach is limited, so just verify no throw
      expect(() => factory.cleanupOrphans()).not.toThrow();
      expect(existsSync(join(TEST_BASE_PATH, 'orphan-a'))).toBe(false);
      expect(existsSync(join(TEST_BASE_PATH, 'orphan-b'))).toBe(false);
    });
  });

  // ─── Config ──────────────────────────────────────────────

  describe('writeConfig / readConfig', () => {
    it('should allow setting non-canonical keys when enforce=true', () => {
      const factory = new WorkspaceFactory(
        { basePath: 'test-workspace', enforceCanonicalConfig: true },
        { $schema: 'https://opencode.ai/config.json' }
      );
      factory.create('conv-config');
      factory.writeConfig('conv-config', { model: 'gpt-4', customKey: 'value' });

      const config = factory.readConfig('conv-config');
      expect(config.$schema).toBe('https://opencode.ai/config.json');
      expect(config.model).toBe('gpt-4');
      expect(config.customKey).toBe('value');
    });

    it('should protect canonical keys when enforce=true', () => {
      const factory = new WorkspaceFactory(
        { basePath: 'test-workspace', enforceCanonicalConfig: true },
        { $schema: 'https://opencode.ai/config.json', permission: { bash: 'deny' } }
      );
      factory.create('conv-config-protect');
      factory.writeConfig('conv-config-protect', { permission: { bash: 'allow' }, model: 'gpt-4' });

      const config = factory.readConfig('conv-config-protect');
      expect(config.permission).toEqual({ bash: 'deny' });
      expect(config.model).toBe('gpt-4');
    });

    it('should write verbatim when enforce=false', () => {
      const factory = new WorkspaceFactory(
        { basePath: 'test-workspace', enforceCanonicalConfig: false },
      );
      factory.create('conv-config-free');
      factory.writeConfig('conv-config-free', { model: 'gpt-4', permission: { bash: 'allow' } });

      const config = factory.readConfig('conv-config-free');
      expect(config.model).toBe('gpt-4');
      expect(config.permission).toEqual({ bash: 'allow' });
    });

    it('should return empty object when config does not exist', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.ensure('conv-config2');

      expect(factory.readConfig('conv-config2')).toEqual({});
    });
  });

  describe('file CRUD', () => {
    it('should write and read files', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-file');

      factory.writeFile('conv-file', 'templates/design-spec.md', '# Design Spec');
      const content = factory.readFile('conv-file', 'templates/design-spec.md');
      expect(content).toBe('# Design Spec');
    });

    it('should list files', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-file-list');

      factory.writeFile('conv-file-list', 'a.md', 'a');
      factory.writeFile('conv-file-list', 'b.md', 'b');

      const files = factory.listFiles('conv-file-list');
      expect(files).toContain('a.md');
      expect(files).toContain('b.md');
    });

    it('should delete files', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-file-del');

      factory.writeFile('conv-file-del', 'temp.txt', 'temp');
      factory.deleteFile('conv-file-del', 'temp.txt');
      expect(() => factory.readFile('conv-file-del', 'temp.txt')).toThrow('File not found');
    });

    it('should block path traversal in file operations', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-sec');

      expect(() => factory.writeFile('conv-sec', '../outside.txt', 'bad')).toThrow('path traversal');
      expect(() => factory.readFile('conv-sec', '../outside.txt')).toThrow('path traversal');
    });

    it('should block absolute paths', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-sec2');

      expect(() => factory.writeFile('conv-sec2', '/etc/passwd', 'bad')).toThrow('absolute paths');
    });

    it('should block backslash-based path traversal', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-sec3');

      expect(() => factory.writeFile('conv-sec3', '..\\..\\outside.txt', 'bad')).toThrow('path traversal');
    });

    it('should throw when reading non-existent file', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-read-miss');

      expect(() => factory.readFile('conv-read-miss', 'no-such-file.txt')).toThrow('File not found');
    });

    it('should throw when listing files in non-existent subdirectory', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-list-miss');

      expect(() => factory.listFiles('conv-list-miss', 'no-such-dir')).toThrow('Directory not found');
    });

    it('should delete directory recursively', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-dir-del');

      // Create a subdirectory with a file
      factory.writeFile('conv-dir-del', 'subdir/test.txt', 'test content');
      expect(existsSync(join(TEST_BASE_PATH, 'conv-dir-del', 'subdir'))).toBe(true);

      // Delete the directory
      factory.deleteFile('conv-dir-del', 'subdir');
      expect(existsSync(join(TEST_BASE_PATH, 'conv-dir-del', 'subdir'))).toBe(false);
    });

    it('should throw when deleting non-existent file', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-del-miss');

      expect(() => factory.deleteFile('conv-del-miss', 'ghost.txt')).toThrow('File not found');
    });
  });

  // ─── Skills ──────────────────────────────────────────────

  describe('copyFromLocal', () => {
    beforeEach(() => {
      // Setup allowed source directories
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

    it('should copy file from allowed source', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-copy');

      factory.copyFromLocal('conv-copy', join('assets', 'template.md'), 'templates/template.md');
      const content = factory.readFile('conv-copy', 'templates/template.md');
      expect(content).toBe('# Template');
    });

    it('should reject copy from disallowed source', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-copy-denied');

      expect(() =>
        factory.copyFromLocal('conv-copy-denied', join('..', 'outside.txt'), 'outside.txt')
      ).toThrow('Source path not allowed');
    });

    it('should throw when copy source not found', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-copy-no-src');

      expect(() =>
        factory.copyFromLocal('conv-copy-no-src', join('assets', 'ghost.txt'), 'ghost.txt')
      ).toThrow('Source not found');
    });

    it('should reject copy from sibling prefix path skills_evil/', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-copy-prefix-evil');

      expect(() =>
        factory.copyFromLocal('conv-copy-prefix-evil', join('skills_evil', 'malicious.txt'), 'malicious.txt')
      ).toThrow('Source path not allowed');
    });

    it('should reject copy from sibling prefix path templates_backup/', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-copy-prefix-bak');

      expect(() =>
        factory.copyFromLocal('conv-copy-prefix-bak', join('templates_backup', 'old.txt'), 'old.txt')
      ).toThrow('Source path not allowed');
    });
  });

  // ─── Quota ───────────────────────────────────────────────

  describe('quota', () => {
    it('should enforce 50MB workspace size limit', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-quota');

      const bigContent = 'x'.repeat(51 * 1024 * 1024); // 51 MB of text

      expect(() => factory.writeFile('conv-quota', 'big.txt', bigContent)).toThrow('quota exceeded');
    });

    it('should calculate workspace size', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-size');
      factory.writeFile('conv-size', 'test.txt', 'hello');

      expect(factory.getWorkspaceSize('conv-size')).toBeGreaterThan(0);
    });
  });
});
