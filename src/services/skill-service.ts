import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, cpSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import AdmZip from 'adm-zip';
import { WorkspaceFactory, validateSkillName, getDirSize, hashDirectory } from '../orchestrator/workspace-factory.js';
import { ConversationState } from '../orchestrator/conversation-state.js';
import { logger } from '../utils/logger.js';

export class SkillService {
  private allowedCopySources: string[];

  constructor(
    private workspaceFactory: WorkspaceFactory,
    private conversationState: ConversationState
  ) {
    this.allowedCopySources = [
      join(process.cwd(), 'assets'),
      join(process.cwd(), 'templates'),
      join(process.cwd(), 'skills'),
    ];
  }

  async uploadSkill(id: string, name: string, zipBuffer: Buffer): Promise<void> {
    const skillName = validateSkillName(name);
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();

    const hasRootSkillMd = entries.some((e) => e.entryName === 'SKILL.md');
    if (!hasRootSkillMd) {
      throw new Error('Skill archive must contain SKILL.md at the root');
    }

    const wsPath = this.workspaceFactory.resolveWorkspacePath(id);
    const destPath = join(wsPath, '.opencode', 'skills', skillName);
    let totalUncompressedSize = 0;

    for (const entry of entries) {
      const entryName = entry.entryName;

      if (entryName.includes('..')) {
        throw new Error(`Invalid zip entry path: ${entryName}`);
      }
      if (entryName.startsWith('/') || entryName.startsWith('\\')) {
        throw new Error(`Invalid zip entry path: ${entryName}`);
      }
      if (/^[A-Za-z]:/i.test(entryName)) {
        throw new Error(`Invalid zip entry path: ${entryName}`);
      }

      const resolvedDest = resolve(destPath);
      const resolvedOutput = resolve(destPath, entryName);
      if (resolvedOutput !== resolvedDest && !resolvedOutput.startsWith(resolvedDest + sep)) {
        throw new Error(`Invalid zip entry path: ${entryName}`);
      }

      totalUncompressedSize += entry.header.size;
    }

    await this.workspaceFactory.assertQuota(id, totalUncompressedSize);

    mkdirSync(destPath, { recursive: true });
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const entryPath = resolve(destPath, entry.entryName);
      mkdirSync(dirname(entryPath), { recursive: true });
      writeFileSync(entryPath, entry.getData());
    }

    logger.info(`Skill uploaded: ${destPath}`);
    this.markNeedsRestartIfRunning(id, `skill ${name} uploaded`);
    this.conversationState.emitEvent(id, 'conversation.configChanged', {
      changedFiles: [`.opencode/skills/${skillName}/`],
    });
  }

  async importSkill(id: string, source: string, name: string): Promise<void> {
    const skillName = validateSkillName(name);
    const wsPath = this.workspaceFactory.resolveWorkspacePath(id);
    const destPath = join(wsPath, '.opencode', 'skills', skillName);

    const resolvedSource = resolve(process.cwd(), source);
    const isAllowed = this.allowedCopySources.some((allowed) => {
      const resolvedAllowed = resolve(allowed);
      return resolvedSource === resolvedAllowed || resolvedSource.startsWith(resolvedAllowed + sep);
    });
    if (!isAllowed) {
      throw new Error(
        `Source path not allowed. Must be under one of: ${this.allowedCopySources.join(', ')}`
      );
    }

    if (!existsSync(resolvedSource)) {
      throw new Error(`Source not found: ${source}`);
    }

    const srcStat = statSync(resolvedSource);
    if (!srcStat.isDirectory()) {
      throw new Error(`Source must be a directory: ${source}`);
    }

    const dirSize = getDirSize(resolvedSource);
    await this.workspaceFactory.assertQuota(id, dirSize);

    mkdirSync(destPath, { recursive: true });
    cpSync(resolvedSource, destPath, { recursive: true, force: true });
    logger.info(`Skill imported: ${resolvedSource} → ${destPath}`);

    this.markNeedsRestartIfRunning(id, `skill ${name} imported`);
    this.conversationState.emitEvent(id, 'conversation.configChanged', {
      changedFiles: [`.opencode/skills/${skillName}/`],
    });
  }

  listSkills(id: string): string[] {
    const wsPath = this.workspaceFactory.resolveWorkspacePath(id);
    const skillsDir = join(wsPath, '.opencode', 'skills');
    if (!existsSync(skillsDir)) return [];
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  readSkill(id: string, name: string): string {
    const skillName = validateSkillName(name);
    const wsPath = this.workspaceFactory.resolveWorkspacePath(id);
    const skillPath = join(wsPath, '.opencode', 'skills', skillName, 'SKILL.md');
    if (!existsSync(skillPath)) {
      throw new Error(`Skill not found: ${name}`);
    }
    return readFileSync(skillPath, 'utf-8');
  }

  getSkillInfo(id: string, name: string): { name: string; files: string[]; totalSize: number; sha256: string } {
    const skillName = validateSkillName(name);
    const wsPath = this.workspaceFactory.resolveWorkspacePath(id);
    const skillDir = join(wsPath, '.opencode', 'skills', skillName);
    if (!existsSync(skillDir)) {
      throw new Error(`Skill not found: ${name}`);
    }
    const info = hashDirectory(skillDir);
    return { name: skillName, ...info };
  }

  deleteSkill(id: string, name: string): void {
    const skillName = validateSkillName(name);
    const wsPath = this.workspaceFactory.resolveWorkspacePath(id);
    const skillDir = join(wsPath, '.opencode', 'skills', skillName);
    if (!existsSync(skillDir)) {
      throw new Error(`Skill not found: ${name}`);
    }
    rmSync(skillDir, { recursive: true, force: true });
    logger.info(`Skill deleted: ${skillDir}`);

    this.markNeedsRestartIfRunning(id, `skill ${skillName} deleted`);
    this.conversationState.emitEvent(id, 'conversation.configChanged', {
      changedFiles: [`.opencode/skills/${skillName}/`],
    });
  }

  private markNeedsRestartIfRunning(id: string, reason: string): void {
    const state = this.conversationState.get(id);
    if (state && state.status === 'running') {
      this.conversationState.markNeedsRestart(id, reason);
    }
  }
}
