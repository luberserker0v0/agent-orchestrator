import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
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
      defaultPermissions: { external_directory: { '*': 'deny' } },
    });

    const info = factory.create('conv-001');

    expect(existsSync(info.path)).toBe(true);
    expect(existsSync(info.opencodeDir)).toBe(true);
    expect(info.id).toBe('conv-001');
  });

  it('should write opencode.json with correct structure', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      defaultPermissions: { external_directory: { '*': 'deny' }, bash: { '*': 'deny' } },
    });

    factory.create('conv-002');

    const configPath = join(TEST_BASE_PATH, 'conv-002', '.opencode', 'opencode.json');
    expect(existsSync(configPath)).toBe(true);

    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(content.$schema).toBe('https://opencode.ai/config.json');
    expect(content.permission).toEqual({
      external_directory: { '*': 'deny' },
      bash: { '*': 'deny' },
    });
    expect(content.model).toBeUndefined();
    expect(content.agent).toBeUndefined();
  });

  it('should include model and agent in opencode.json when provided', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      defaultPermissions: {},
    });

    factory.create('conv-003', { model: 'anthropic/claude-3-5-sonnet', agent: 'build' });

    const configPath = join(TEST_BASE_PATH, 'conv-003', '.opencode', 'opencode.json');
    const content = JSON.parse(readFileSync(configPath, 'utf-8'));

    expect(content.model).toBe('anthropic/claude-3-5-sonnet');
    expect(content.agent).toBe('build');
  });

  it('should sanitize id to prevent path traversal', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      defaultPermissions: {},
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
      defaultPermissions: {},
    });

    const info = factory.create();

    // UUID format validation (rough)
    expect(info.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(existsSync(info.path)).toBe(true);
  });

  it('should not throw when creating existing workspace (recursive)', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      defaultPermissions: {},
    });

    factory.create('conv-004');
    // Second creation should not throw because mkdirSync uses recursive: true
    expect(() => factory.create('conv-004')).not.toThrow();
  });

  it('should destroy workspace and remove files', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      defaultPermissions: {},
    });

    const info = factory.create('conv-005');
    expect(existsSync(info.path)).toBe(true);

    factory.destroy('conv-005');
    expect(existsSync(info.path)).toBe(false);
  });

  it('should not throw when destroying non-existent workspace', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      defaultPermissions: {},
    });

    expect(() => factory.destroy('non-existent')).not.toThrow();
  });
});
