import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, cpSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  existsSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
  cpSync: vi.fn(),
}));

vi.mock('../orchestrator/workspace-factory.js', () => ({
  WorkspaceFactory: class {},
  validateSkillName: vi.fn().mockImplementation((n: string) => n.replace(/[^a-zA-Z0-9_-]/g, '_')),
  getDirSize: vi.fn().mockReturnValue(100),
  hashDirectory: vi.fn().mockReturnValue({
    files: ['SKILL.md', 'script.js'],
    totalSize: 500,
    sha256: 'abc123',
  }),
}));

vi.mock('adm-zip', () => ({
  default: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import AdmZip from 'adm-zip';
import { SkillService } from './skill-service.js';

function makeMockEntry(name: string, isDir = false, size = 100) {
  return {
    entryName: name,
    isDirectory: isDir,
    header: { size },
    getData: vi.fn().mockReturnValue(Buffer.from('mock data')),
  };
}

describe('SkillService', () => {
  let skillService: SkillService;
  let mockWorkspaceFactory: any;
  let mockConversationState: any;
  const testId = 'test-conv';
  const mockWsPath = '/tmp/workspace/test-conv';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('# SKILL content');
    vi.mocked(readdirSync).mockReturnValue([]);
    vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);

    mockWorkspaceFactory = {
      resolveWorkspacePath: vi.fn().mockReturnValue(mockWsPath),
      assertQuota: vi.fn().mockResolvedValue(undefined),
    };

    mockConversationState = {
      get: vi.fn().mockReturnValue({ status: 'prepared', ready: false }),
      markNeedsRestart: vi.fn(),
      emitEvent: vi.fn(),
    };

    skillService = new SkillService(mockWorkspaceFactory, mockConversationState);
  });

  function makeRunning(): void {
    mockConversationState.get.mockReturnValue({ status: 'running', ready: true });
  }

  function mockZipEntries(entries: ReturnType<typeof makeMockEntry>[]): void {
    vi.mocked(AdmZip).mockImplementationOnce(function () {
      return {
        getEntries: vi.fn().mockReturnValue(entries),
      };
    });
  }

  describe('uploadSkill', () => {
    it('should extract zip to skill directory', async () => {
      mockZipEntries([makeMockEntry('SKILL.md')]);

      await skillService.uploadSkill(testId, 'my-skill', Buffer.from('zip data'));

      expect(AdmZip).toHaveBeenCalledWith(Buffer.from('zip data'));
      expect(mockWorkspaceFactory.resolveWorkspacePath).toHaveBeenCalledWith(testId);

      const destPath = join(mockWsPath, '.opencode', 'skills', 'my-skill');
      expect(mkdirSync).toHaveBeenCalledWith(destPath, { recursive: true });
    });

    it('should reject zip without SKILL.md at root', async () => {
      mockZipEntries([makeMockEntry('subdir/file.js')]);

      await expect(skillService.uploadSkill(testId, 'bad-skill', Buffer.from('zip'))).rejects.toThrow(
        'Skill archive must contain SKILL.md at the root'
      );
    });

    it('should reject zip with path traversal in entry', async () => {
      mockZipEntries([
        makeMockEntry('SKILL.md'),
        makeMockEntry('../escape.txt'),
      ]);

      await expect(skillService.uploadSkill(testId, 'bad-skill', Buffer.from('zip'))).rejects.toThrow(
        'Invalid zip entry path'
      );
    });

    it('should reject zip with absolute path entry', async () => {
      mockZipEntries([
        makeMockEntry('SKILL.md'),
        makeMockEntry('/etc/passwd'),
      ]);

      await expect(skillService.uploadSkill(testId, 'bad-skill', Buffer.from('zip'))).rejects.toThrow(
        'Invalid zip entry path'
      );
    });

    it('should check quota before extracting', async () => {
      mockZipEntries([makeMockEntry('SKILL.md')]);

      await skillService.uploadSkill(testId, 'my-skill', Buffer.from('zip data'));

      expect(mockWorkspaceFactory.assertQuota).toHaveBeenCalledWith(testId, expect.any(Number));
    });

    it('should write zip entries to disk', async () => {
      mockZipEntries([
        makeMockEntry('SKILL.md'),
        makeMockEntry('scripts/main.ts'),
      ]);

      await skillService.uploadSkill(testId, 'my-skill', Buffer.from('zip'));

      expect(writeFileSync).toHaveBeenCalledTimes(2);
    });

    it('should mark needsRestart and emit event when running', async () => {
      makeRunning();
      mockZipEntries([makeMockEntry('SKILL.md')]);

      await skillService.uploadSkill(testId, 'my-skill', Buffer.from('zip data'));

      expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith(testId, 'skill my-skill uploaded');
      expect(mockConversationState.emitEvent).toHaveBeenCalledWith(testId, 'conversation.configChanged', {
        changedFiles: ['.opencode/skills/my-skill/'],
      });
    });

    it('should not mark needsRestart when not running', async () => {
      mockZipEntries([makeMockEntry('SKILL.md')]);

      await skillService.uploadSkill(testId, 'my-skill', Buffer.from('zip data'));

      expect(mockConversationState.markNeedsRestart).not.toHaveBeenCalled();
      expect(mockConversationState.emitEvent).toHaveBeenCalled();
    });
  });

  describe('importSkill', () => {
    it('should copy source directory to skills', async () => {
      const srcPath = join(process.cwd(), 'skills', 'custom-skill');

      await skillService.importSkill(testId, srcPath, 'imported-skill');

      const destPath = join(mockWsPath, '.opencode', 'skills', 'imported-skill');
      expect(cpSync).toHaveBeenCalledWith(srcPath, destPath, { recursive: true, force: true });
    });

    it('should reject non-allowed source path', async () => {
      await expect(skillService.importSkill(testId, '/etc/passwd', 'bad')).rejects.toThrow(
        'Source path not allowed'
      );
    });

    it('should reject non-existent source', async () => {
      const srcPath = join(process.cwd(), 'skills', 'custom-skill');
      vi.mocked(existsSync).mockReturnValue(false);

      await expect(skillService.importSkill(testId, srcPath, 'imported-skill')).rejects.toThrow(
        'Source not found'
      );
    });

    it('should reject non-directory source', async () => {
      const srcPath = join(process.cwd(), 'skills', 'custom-skill');
      vi.mocked(statSync).mockReturnValue({ isDirectory: () => false } as any);
      vi.mocked(existsSync).mockReturnValue(true);

      await expect(skillService.importSkill(testId, srcPath, 'imported-skill')).rejects.toThrow(
        'Source must be a directory'
      );
    });

    it('should check quota before copying', async () => {
      const srcPath = join(process.cwd(), 'skills', 'custom-skill');

      await skillService.importSkill(testId, srcPath, 'imported-skill');

      expect(mockWorkspaceFactory.assertQuota).toHaveBeenCalledWith(testId, expect.any(Number));
    });

    it('should reject non-allowed path under allowed base', async () => {
      const skipPath = join(process.cwd(), '.opencode', 'secrets');
      const srcPath = join(skipPath, 'my-skill');
      vi.mocked(existsSync).mockReturnValue(true);

      await expect(skillService.importSkill(testId, srcPath, 'imported-skill')).rejects.toThrow(
        'Source path not allowed'
      );
    });

    it('should mark needsRestart and emit event when running', async () => {
      makeRunning();
      const srcPath = join(process.cwd(), 'skills', 'custom-skill');

      await skillService.importSkill(testId, srcPath, 'imported-skill');

      expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith(testId, 'skill imported-skill imported');
      expect(mockConversationState.emitEvent).toHaveBeenCalledWith(testId, 'conversation.configChanged', {
        changedFiles: ['.opencode/skills/imported-skill/'],
      });
    });
  });

  describe('listSkills', () => {
    it('should return directory names from skills dir', () => {
      const makeDirent = (name: string, isDir: boolean) => ({ name, isDirectory: () => isDir });
      vi.mocked(readdirSync).mockReturnValue([
        makeDirent('skill-one', true),
        makeDirent('skill-two', true),
        makeDirent('readme.txt', false),
      ] as any);

      const result = skillService.listSkills(testId);

      expect(result).toEqual(['skill-one', 'skill-two']);
    });

    it('should return empty array when skills dir does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = skillService.listSkills(testId);

      expect(result).toEqual([]);
    });
  });

  describe('readSkill', () => {
    it('should return SKILL.md content', () => {
      vi.mocked(readFileSync).mockReturnValueOnce('# Skill content');

      const result = skillService.readSkill(testId, 'my-skill');

      expect(result).toBe('# Skill content');
    });

    it('should throw when skill does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      expect(() => skillService.readSkill(testId, 'missing')).toThrow('Skill not found: missing');
    });
  });

  describe('getSkillInfo', () => {
    it('should return skill directory info', () => {
      const result = skillService.getSkillInfo(testId, 'my-skill');

      expect(result).toEqual({
        name: 'my-skill',
        files: ['SKILL.md', 'script.js'],
        totalSize: 500,
        sha256: 'abc123',
      });
    });

    it('should throw when skill directory does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      expect(() => skillService.getSkillInfo(testId, 'missing')).toThrow('Skill not found: missing');
    });
  });

  describe('deleteSkill', () => {
    it('should delete skill directory and emit events', () => {
      const destPath = join(mockWsPath, '.opencode', 'skills', 'my-skill');

      skillService.deleteSkill(testId, 'my-skill');

      expect(rmSync).toHaveBeenCalledWith(destPath, { recursive: true, force: true });
      expect(mockConversationState.emitEvent).toHaveBeenCalledWith(testId, 'conversation.configChanged', {
        changedFiles: ['.opencode/skills/my-skill/'],
      });
    });

    it('should throw when skill does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      expect(() => skillService.deleteSkill(testId, 'missing')).toThrow('Skill not found: missing');
    });

    it('should mark needsRestart when running', () => {
      makeRunning();

      skillService.deleteSkill(testId, 'my-skill');

      expect(mockConversationState.markNeedsRestart).toHaveBeenCalledWith(testId, 'skill my-skill deleted');
    });
  });

  describe('agent-scoped skills', () => {
    const agentName = 'my-agent';

    describe('uploadSkill with agentName', () => {
      it('should extract zip to agent skill directory', async () => {
        mockZipEntries([makeMockEntry('SKILL.md')]);

        await skillService.uploadSkill(testId, 'my-skill', Buffer.from('zip data'), agentName);

        const destPath = join(mockWsPath, '.opencode', 'agents', agentName, 'skills', 'my-skill');
        expect(mkdirSync).toHaveBeenCalledWith(destPath, { recursive: true });
      });

      it('should emit event with agent-scoped changedFiles', async () => {
        makeRunning();
        mockZipEntries([makeMockEntry('SKILL.md')]);

        await skillService.uploadSkill(testId, 'my-skill', Buffer.from('zip data'), agentName);

        expect(mockConversationState.emitEvent).toHaveBeenCalledWith(testId, 'conversation.configChanged', {
          changedFiles: [`.opencode/agents/${agentName}/skills/my-skill/`],
        });
      });
    });

    describe('importSkill with agentName', () => {
      it('should copy source to agent skill directory', async () => {
        const srcPath = join(process.cwd(), 'skills', 'custom-skill');

        await skillService.importSkill(testId, srcPath, 'imported-skill', agentName);

        const destPath = join(mockWsPath, '.opencode', 'agents', agentName, 'skills', 'imported-skill');
        expect(cpSync).toHaveBeenCalledWith(srcPath, destPath, { recursive: true, force: true });
      });

      it('should emit event with agent-scoped changedFiles', async () => {
        makeRunning();
        const srcPath = join(process.cwd(), 'skills', 'custom-skill');

        await skillService.importSkill(testId, srcPath, 'imported-skill', agentName);

        expect(mockConversationState.emitEvent).toHaveBeenCalledWith(testId, 'conversation.configChanged', {
          changedFiles: [`.opencode/agents/${agentName}/skills/imported-skill/`],
        });
      });
    });

    describe('listSkills with agentName', () => {
      it('should list from agent skill directory', () => {
        const makeDirent = (name: string, isDir: boolean) => ({ name, isDirectory: () => isDir });
        vi.mocked(readdirSync).mockReturnValue([
          makeDirent('agent-skill', true),
        ] as any);

        const result = skillService.listSkills(testId, agentName);

        expect(result).toEqual(['agent-skill']);
        const calledPath = vi.mocked(readdirSync).mock.calls[0][0] as string;
        expect(calledPath).toContain(join('.opencode', 'agents', agentName, 'skills'));
      });
    });

    describe('readSkill with agentName', () => {
      it('should read from agent skill directory', () => {
        vi.mocked(readFileSync).mockReturnValueOnce('# Agent skill');

        const result = skillService.readSkill(testId, 'my-skill', agentName);

        expect(result).toBe('# Agent skill');
      });
    });

    describe('getSkillInfo with agentName', () => {
      it('should return info from agent skill directory', () => {
        const result = skillService.getSkillInfo(testId, 'my-skill', agentName);

        expect(result).toEqual({
          name: 'my-skill',
          files: ['SKILL.md', 'script.js'],
          totalSize: 500,
          sha256: 'abc123',
        });
      });
    });

    describe('deleteSkill with agentName', () => {
      it('should delete from agent skill directory', () => {
        skillService.deleteSkill(testId, 'my-skill', agentName);

        const destPath = join(mockWsPath, '.opencode', 'agents', agentName, 'skills', 'my-skill');
        expect(rmSync).toHaveBeenCalledWith(destPath, { recursive: true, force: true });
      });

      it('should emit event with agent-scoped changedFiles', () => {
        makeRunning();

        skillService.deleteSkill(testId, 'my-skill', agentName);

        expect(mockConversationState.emitEvent).toHaveBeenCalledWith(testId, 'conversation.configChanged', {
          changedFiles: [`.opencode/agents/${agentName}/skills/my-skill/`],
        });
      });
    });
  });
});
