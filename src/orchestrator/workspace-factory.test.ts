import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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
    expect(content.default_agent).toBeUndefined();
  });

  it('should include model, agent and default_agent in opencode.json when provided', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      defaultPermissions: {},
    });

    factory.create('conv-003', {
      model: 'anthropic/claude-3-5-sonnet',
      agent: { moderator: { description: 'moderator agent' } },
      default_agent: 'moderator',
    });

    const configPath = join(TEST_BASE_PATH, 'conv-003', '.opencode', 'opencode.json');
    const content = JSON.parse(readFileSync(configPath, 'utf-8'));

    expect(content.model).toBe('anthropic/claude-3-5-sonnet');
    expect(content.agent).toEqual({ moderator: { description: 'moderator agent' } });
    expect(content.default_agent).toBe('moderator');
  });

  it('should set default_agent without agent object', () => {
    const factory = new WorkspaceFactory({
      basePath: 'test-workspace',
      defaultPermissions: {},
    });

    factory.create('conv-defagent', { default_agent: 'plan' });

    const configPath = join(TEST_BASE_PATH, 'conv-defagent', '.opencode', 'opencode.json');
    const content = JSON.parse(readFileSync(configPath, 'utf-8'));

    expect(content.model).toBeUndefined();
    expect(content.agent).toBeUndefined();
    expect(content.default_agent).toBe('plan');
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

  // ─── Config ──────────────────────────────────────────────

  describe('writeConfig / readConfig', () => {
    it('should overwrite opencode.json completely', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-config');

      factory.writeConfig('conv-config', { model: 'gpt-4', customKey: 'value' });

      const config = factory.readConfig('conv-config');
      expect(config.model).toBe('gpt-4');
      expect(config.customKey).toBe('value');
      expect(config.$schema).toBeUndefined(); // fully overwritten
    });

    it('should return empty object when config does not exist', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-config2');
      rmSync(join(TEST_BASE_PATH, 'conv-config2', '.opencode', 'opencode.json'));

      expect(factory.readConfig('conv-config2')).toEqual({});
    });
  });

  // ─── Agents ──────────────────────────────────────────────

  describe('agent CRUD', () => {
    it('should write and read agent markdown', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-agent');

      factory.writeAgent('conv-agent', 'designer', '---\nmode: subagent\n---\nYou are a designer.');
      const content = factory.readAgent('conv-agent', 'designer');
      expect(content).toBe('---\nmode: subagent\n---\nYou are a designer.');
    });

    it('should list agents', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
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
        defaultPermissions: {},
      });
      factory.create('conv-agent-del');

      factory.writeAgent('conv-agent-del', 'temp', 'temp content');
      factory.deleteAgent('conv-agent-del', 'temp');

      expect(factory.listAgents('conv-agent-del')).not.toContain('temp');
    });

    it('should throw when reading non-existent agent', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-agent-miss');

      expect(() => factory.readAgent('conv-agent-miss', 'missing')).toThrow('Agent not found');
    });
  });

  // ─── Generic Files ───────────────────────────────────────

  describe('file CRUD', () => {
    it('should write and read files', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-file');

      factory.writeFile('conv-file', 'templates/design-spec.md', '# Design Spec');
      const content = factory.readFile('conv-file', 'templates/design-spec.md');
      expect(content).toBe('# Design Spec');
    });

    it('should list files', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
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
        defaultPermissions: {},
      });
      factory.create('conv-file-del');

      factory.writeFile('conv-file-del', 'temp.txt', 'temp');
      factory.deleteFile('conv-file-del', 'temp.txt');
      expect(() => factory.readFile('conv-file-del', 'temp.txt')).toThrow('File not found');
    });

    it('should block path traversal in file operations', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-sec');

      expect(() => factory.writeFile('conv-sec', '../outside.txt', 'bad')).toThrow('path traversal');
      expect(() => factory.readFile('conv-sec', '../outside.txt')).toThrow('path traversal');
    });

    it('should block absolute paths', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-sec2');

      expect(() => factory.writeFile('conv-sec2', '/etc/passwd', 'bad')).toThrow('absolute paths');
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
        defaultPermissions: {},
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
        defaultPermissions: {},
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
        defaultPermissions: {},
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
        defaultPermissions: {},
      });
      factory.create('conv-skill-del-miss');

      expect(() => factory.deleteSkill('conv-skill-del-miss', 'missing')).toThrow('Skill not found');
    });

    it('should reject import from disallowed source', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-skill-denied');

      expect(() =>
        factory.importSkillFromLocal('conv-skill-denied', join('..', 'outside'), 'outside')
      ).toThrow('Source path not allowed');
    });

    it('should reject invalid skill name in importSkillFromLocal', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-invalid-import');

      expect(() =>
        factory.importSkillFromLocal('conv-invalid-import', join('skills', 'test'), 'foo/bar')
      ).toThrow('Invalid skill name');
    });

    it('should reject invalid skill name in readSkill', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-invalid-read');

      expect(() => factory.readSkill('conv-invalid-read', 'foo/bar')).toThrow('Invalid skill name');
    });

    it('should reject invalid skill name in getSkillInfo', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-invalid-info');

      expect(() => factory.getSkillInfo('conv-invalid-info', 'foo/bar')).toThrow('Invalid skill name');
    });

    it('should reject invalid skill name in deleteSkill', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-invalid-delete');

      expect(() => factory.deleteSkill('conv-invalid-delete', 'foo/bar')).toThrow('Invalid skill name');
    });

    it('should reject sibling prefix path skills_evil/', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-prefix-evil');

      expect(() =>
        factory.importSkillFromLocal('conv-prefix-evil', join('skills_evil', 'web-search'), 'web-search')
      ).toThrow('Source path not allowed');
    });

    it('should reject sibling prefix path assets_backup/', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-prefix-assets');

      expect(() =>
        factory.importSkillFromLocal('conv-prefix-assets', join('assets_backup', 'shared-skill'), 'shared-skill')
      ).toThrow('Source path not allowed');
    });

    it('should reject sibling prefix path templates-old/', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
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
        defaultPermissions: {},
      });
      factory.create('conv-copy');

      factory.copyFromLocal('conv-copy', join('assets', 'template.md'), 'templates/template.md');
      const content = factory.readFile('conv-copy', 'templates/template.md');
      expect(content).toBe('# Template');
    });

    it('should reject copy from disallowed source', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-copy-denied');

      expect(() =>
        factory.copyFromLocal('conv-copy-denied', join('..', 'outside.txt'), 'outside.txt')
      ).toThrow('Source path not allowed');
    });

    it('should reject copy from sibling prefix path skills_evil/', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-copy-prefix-evil');

      expect(() =>
        factory.copyFromLocal('conv-copy-prefix-evil', join('skills_evil', 'malicious.txt'), 'malicious.txt')
      ).toThrow('Source path not allowed');
    });

    it('should reject copy from sibling prefix path templates_backup/', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
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
        defaultPermissions: {},
      });
      factory.create('conv-quota');

      const bigContent = 'x'.repeat(51 * 1024 * 1024); // 51 MB of text

      expect(() => factory.writeFile('conv-quota', 'big.txt', bigContent)).toThrow('quota exceeded');
    });

    it('should calculate workspace size', () => {
      const factory = new WorkspaceFactory({
        basePath: 'test-workspace',
        defaultPermissions: {},
      });
      factory.create('conv-size');
      factory.writeFile('conv-size', 'test.txt', 'hello');

      expect(factory.getWorkspaceSize('conv-size')).toBeGreaterThan(0);
    });
  });
});
