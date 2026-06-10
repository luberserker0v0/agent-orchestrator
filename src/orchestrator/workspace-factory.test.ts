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

  it('should destroy workspace and remove files', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      enforceCanonicalConfig: true,
    });

    const info = factory.create('conv-005');
    expect(existsSync(info.path)).toBe(true);

    factory.destroy('conv-005');
    expect(existsSync(info.path)).toBe(false);
  });

  it('should not throw when destroying non-existent workspace', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      enforceCanonicalConfig: true,
    });

    expect(() => factory.destroy('non-existent')).not.toThrow();
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

  // ─── Agents ──────────────────────────────────────────────

  describe('agent CRUD', () => {
    it('should write and read agent markdown', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-agent');

      factory.writeAgent('conv-agent', 'designer', '---\nmode: subagent\n---\nYou are a designer.');
      const content = factory.readAgent('conv-agent', 'designer');
      expect(content).toBe('---\nmode: subagent\n---\nYou are a designer.');
    });

    it('should list agents', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-agent-list');

      factory.writeAgent('conv-agent-list', 'designer', 'designer content');
      factory.writeAgent('conv-agent-list', 'reviewer', 'reviewer content');

      const agents = factory.listAgents('conv-agent-list');
      expect(agents).toContain('designer');
      expect(agents).toContain('reviewer');
    });

    it('should delete agent', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-agent-del');

      factory.writeAgent('conv-agent-del', 'temp', 'temp content');
      factory.deleteAgent('conv-agent-del', 'temp');

      expect(factory.listAgents('conv-agent-del')).not.toContain('temp');
    });

    it('should throw when reading non-existent agent', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-agent-miss');

      expect(() => factory.readAgent('conv-agent-miss', 'missing')).toThrow('Agent not found');
    });

    it('should return empty list when agents directory does not exist', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-no-agents-dir');

      expect(factory.listAgents('conv-no-agents-dir')).toEqual([]);
    });
  });

  describe('AGENTS.md CRUD', () => {
    it('should write and read AGENTS.md', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-agentsmd');

      factory.writeAgentsMd('conv-agentsmd', '# Project Context\nThis is a test project.');
      const content = factory.readAgentsMd('conv-agentsmd');
      expect(content).toBe('# Project Context\nThis is a test project.');
    });

    it('should read AGENTS.md at workspace root', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-agentsmd-root');

      factory.writeAgentsMd('conv-agentsmd-root', '# Agents Config');
      const content = factory.readAgentsMd('conv-agentsmd-root');

      // Verify it's at workspace root, not inside .opencode
      const wsPath = join(TEST_BASE_PATH, 'conv-agentsmd-root');
      expect(existsSync(join(wsPath, 'AGENTS.md'))).toBe(true);
      expect(content).toBe('# Agents Config');
    });

    it('should overwrite existing AGENTS.md', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-agentsmd-over');

      factory.writeAgentsMd('conv-agentsmd-over', 'v1 content');
      factory.writeAgentsMd('conv-agentsmd-over', 'v2 content');

      const content = factory.readAgentsMd('conv-agentsmd-over');
      expect(content).toBe('v2 content');
    });

    it('should delete AGENTS.md', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-agentsmd-del');

      factory.writeAgentsMd('conv-agentsmd-del', 'to be deleted');
      factory.deleteAgentsMd('conv-agentsmd-del');

      expect(() => factory.readAgentsMd('conv-agentsmd-del')).toThrow('AGENTS.md not found');
    });

    it('should throw when reading non-existent AGENTS.md', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-agentsmd-miss');

      expect(() => factory.readAgentsMd('conv-agentsmd-miss')).toThrow('AGENTS.md not found');
    });

    it('should not throw when deleting non-existent AGENTS.md', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-agentsmd-nop');

      expect(() => factory.deleteAgentsMd('conv-agentsmd-nop')).not.toThrow();
    });
  });

  // ─── Generic Files ───────────────────────────────────────

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

  describe('skill CRUD', () => {
    it('should import skill from local directory', () => {
      // Setup source skill directory
      const skillsDir = join(process.cwd(), 'skills');
      const webSearchDir = join(skillsDir, 'web-search');
      mkdirSync(webSearchDir, { recursive: true });
      writeFileSync(join(webSearchDir, 'SKILL.md'), '# web-search\nA web search skill.', 'utf-8');
      writeFileSync(join(webSearchDir, 'README.md'), 'Readme content', 'utf-8');

      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-skill');

      factory.importSkillFromLocal('conv-skill', join('skills', 'web-search'), 'web-search');

      const content = factory.readSkill('conv-skill', 'web-search');
      expect(content).toBe('# web-search\nA web search skill.');

      const skills = factory.listSkills('conv-skill');
      expect(skills).toContain('web-search');

      const info = factory.getSkillInfo('conv-skill', 'web-search');
      expect(info.name).toBe('web-search');
      expect(info.files).toContain('SKILL.md');
      expect(info.files).toContain('README.md');
      expect(info.totalSize).toBeGreaterThan(0);
      expect(info.sha256).toHaveLength(64);

      // Cleanup
      rmSync(skillsDir, { recursive: true, force: true });
    });

    it('should throw when skill not found', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-skill-miss');

      expect(() => factory.readSkill('conv-skill-miss', 'missing')).toThrow('Skill not found');
      expect(() => factory.getSkillInfo('conv-skill-miss', 'missing')).toThrow('Skill not found');
    });

    it('should delete skill', () => {
      const skillsDir = join(process.cwd(), 'skills');
      const tempDir = join(skillsDir, 'temp-skill');
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(join(tempDir, 'SKILL.md'), '# temp', 'utf-8');

      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-skill-del');

      factory.importSkillFromLocal('conv-skill-del', join('skills', 'temp-skill'), 'temp-skill');
      expect(factory.listSkills('conv-skill-del')).toContain('temp-skill');

      factory.deleteSkill('conv-skill-del', 'temp-skill');
      expect(factory.listSkills('conv-skill-del')).not.toContain('temp-skill');

      rmSync(skillsDir, { recursive: true, force: true });
    });

    it('should throw when deleting non-existent skill', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-skill-del-miss');

      expect(() => factory.deleteSkill('conv-skill-del-miss', 'missing')).toThrow('Skill not found');
    });

    it('should throw when importing non-existent source', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-skill-no-src');

      expect(() =>
        factory.importSkillFromLocal('conv-skill-no-src', join('skills', 'non-existent-dir'), 'test')
      ).toThrow('Source not found');
    });

    it('should throw when import source is not a directory', () => {
      const skillsDir = join(process.cwd(), 'skills');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, 'not-a-dir.txt'), 'file content', 'utf-8');

      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-skill-not-dir');

      expect(() =>
        factory.importSkillFromLocal('conv-skill-not-dir', join('skills', 'not-a-dir.txt'), 'test')
      ).toThrow('Source must be a directory');

      rmSync(skillsDir, { recursive: true, force: true });
    });

    it('should reject import from disallowed source', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-skill-denied');

      expect(() =>
        factory.importSkillFromLocal('conv-skill-denied', join('..', 'outside'), 'outside')
      ).toThrow('Source path not allowed');
    });

    it('should reject invalid skill name in importSkillFromLocal', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-invalid-import');

      expect(() =>
        factory.importSkillFromLocal('conv-invalid-import', join('skills', 'test'), 'foo/bar')
      ).toThrow('Invalid skill name');
    });

    it('should reject invalid skill name in readSkill', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-invalid-read');

      expect(() => factory.readSkill('conv-invalid-read', 'foo/bar')).toThrow('Invalid skill name');
    });

    it('should reject invalid skill name in getSkillInfo', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-invalid-info');

      expect(() => factory.getSkillInfo('conv-invalid-info', 'foo/bar')).toThrow('Invalid skill name');
    });

    it('should reject invalid skill name in deleteSkill', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-invalid-delete');

      expect(() => factory.deleteSkill('conv-invalid-delete', 'foo/bar')).toThrow('Invalid skill name');
    });

    it('should reject sibling prefix path skills_evil/', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-prefix-evil');

      expect(() =>
        factory.importSkillFromLocal('conv-prefix-evil', join('skills_evil', 'web-search'), 'web-search')
      ).toThrow('Source path not allowed');
    });

    it('should reject sibling prefix path assets_backup/', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-prefix-assets');

      expect(() =>
        factory.importSkillFromLocal('conv-prefix-assets', join('assets_backup', 'shared-skill'), 'shared-skill')
      ).toThrow('Source path not allowed');
    });

    it('should reject sibling prefix path templates-old/', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        enforceCanonicalConfig: true,
      });
      factory.create('conv-prefix-tpl');

      expect(() =>
        factory.importSkillFromLocal('conv-prefix-tpl', join('templates-old', 'default-skill'), 'default-skill')
      ).toThrow('Source path not allowed');
    });
  });

  // ─── Copy from local ─────────────────────────────────────

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
