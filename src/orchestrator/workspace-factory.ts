import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  copyFileSync,
  cpSync,
} from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { WorkspaceConfig } from '../config-loader.js';
import type { OpencodeConfig } from '../opencode-http/types.js';

export interface WorkspaceInfo {
  id: string;
  path: string;
  opencodeDir: string;
}

const MAX_WORKSPACE_SIZE = 50 * 1024 * 1024; // 50 MB

function sanitizeId(raw: string): string {
  return raw.replace(/[\\/]/g, '_').replace(/\.{2,}/g, '_');
}

function sanitizeRelativePath(raw: string): string {
  // Reject absolute paths and traversal before normalization
  if (raw.includes('..')) {
    throw new Error('Invalid path: path traversal detected');
  }
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    throw new Error('Invalid path: absolute paths not allowed');
  }
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.includes('..')) {
    throw new Error('Invalid path: path traversal detected');
  }
  if (normalized.startsWith('/')) {
    throw new Error('Invalid path: absolute paths not allowed');
  }
  return normalized;
}

export function validateSkillName(name: string): string {
  if (!name || typeof name !== 'string') {
    throw new Error('Invalid skill name');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name)) {
    throw new Error('Invalid skill name');
  }
  return name;
}

export function getDirSize(dirPath: string): number {
  let total = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += getDirSize(fullPath);
      } else {
        total += statSync(fullPath).size;
      }
    }
  } catch {
    // ignore errors reading directory
  }
  return total;
}

function ensureWithinWorkspace(workspacePath: string, relativePath: string): string {
  const resolved = join(workspacePath, relativePath);
  const realWorkspace = workspacePath;
  if (!resolved.startsWith(realWorkspace)) {
    throw new Error('Invalid path: resolves outside workspace');
  }
  return resolved;
}

export class WorkspaceFactory {
  private basePath: string;
  private canonicalConfig: Record<string, unknown>;
  private enforceCanonicalConfig: boolean;
  private allowedCopySources: string[];

  constructor(config: WorkspaceConfig, canonicalConfig?: Record<string, unknown>) {
    this.basePath = resolve(process.cwd(), config.basePath);
    this.enforceCanonicalConfig = config.enforceCanonicalConfig;
    this.canonicalConfig = canonicalConfig ?? {};
    this.allowedCopySources = [
      join(process.cwd(), 'assets'),
      join(process.cwd(), 'templates'),
      join(process.cwd(), 'skills'),
    ];
  }

  create(id?: string): WorkspaceInfo {
    const wsId = id ? sanitizeId(id) : randomUUID();
    const wsPath = join(this.basePath, wsId);
    const opencodeDir = join(wsPath, '.opencode');

    mkdirSync(opencodeDir, { recursive: true });

    logger.info(`Workspace created: ${wsPath}`);
    return { id: wsId, path: wsPath, opencodeDir };
  }

  ensure(id: string): WorkspaceInfo {
    const wsId = sanitizeId(id);
    const wsPath = join(this.basePath, wsId);
    const opencodeDir = join(wsPath, '.opencode');
    mkdirSync(opencodeDir, { recursive: true });
    return { id: wsId, path: wsPath, opencodeDir };
  }

  destroy(id: string): void {
    const wsId = sanitizeId(id);
    const wsPath = join(this.basePath, wsId);
    if (existsSync(wsPath)) {
      rmSync(wsPath, { recursive: true, force: true });
      logger.info(`Workspace destroyed: ${wsPath}`);
    } else {
      logger.warn(`Workspace not found for destruction: ${wsPath}`);
    }
  }

  cleanupOrphans(): void {
    if (!existsSync(this.basePath)) {
      logger.info('No workspace directory to clean up');
      return;
    }

    const entries = readdirSync(this.basePath);
    if (entries.length === 0) {
      logger.info('Workspace directory is empty, nothing to clean up');
      return;
    }

    let cleaned = 0;
    for (const entry of entries) {
      const fullPath = join(this.basePath, entry);
      try {
        rmSync(fullPath, { recursive: true, force: true });
        cleaned++;
      } catch (err) {
        logger.error(`Failed to remove orphan workspace: ${fullPath}`, err);
      }
    }
    logger.info(`Cleaned up ${cleaned} orphan workspace(s)`);
  }

  // ─── Config ──────────────────────────────────────────────

  writeConfig(id: string, config: OpencodeConfig): void {
    const wsPath = this.resolveWorkspacePath(id);
    const opencodeDir = join(wsPath, '.opencode');
    mkdirSync(opencodeDir, { recursive: true });

    let result: Record<string, unknown>;
    if (this.enforceCanonicalConfig) {
      result = structuredClone(this.canonicalConfig);
      for (const key of Object.keys(config)) {
        if (!Object.hasOwn(this.canonicalConfig, key)) {
          result[key] = config[key];
        }
      }
    } else {
      result = config as unknown as Record<string, unknown>;
    }

    writeFileSync(
      join(opencodeDir, 'opencode.json'),
      JSON.stringify(result, null, 2),
      'utf-8'
    );
    logger.info(`Config written for workspace: ${wsPath}`);
  }

  readConfig(id: string): OpencodeConfig {
    const wsPath = this.resolveWorkspacePath(id);
    const configPath = join(wsPath, '.opencode', 'opencode.json');
    if (!existsSync(configPath)) {
      return {};
    }
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as OpencodeConfig;
  }

  // ─── Generic Files ───────────────────────────────────────

  writeFile(id: string, relativePath: string, content: string): void {
    const sanitized = sanitizeRelativePath(relativePath);
    const wsPath = this.resolveWorkspacePath(id);
    const filePath = ensureWithinWorkspace(wsPath, sanitized);

    const size = Buffer.byteLength(content, 'utf-8');
    this.assertQuota(wsPath, size, filePath);

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
    logger.info(`File written: ${filePath}`);
  }

  readFile(id: string, relativePath: string): string {
    const sanitized = sanitizeRelativePath(relativePath);
    const wsPath = this.resolveWorkspacePath(id);
    const filePath = ensureWithinWorkspace(wsPath, sanitized);
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${sanitized}`);
    }
    return readFileSync(filePath, 'utf-8');
  }

  listFiles(id: string, relativePath = ''): string[] {
    const sanitized = relativePath ? sanitizeRelativePath(relativePath) : '';
    const wsPath = this.resolveWorkspacePath(id);
    const dirPath = sanitized ? ensureWithinWorkspace(wsPath, sanitized) : wsPath;
    if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
      throw new Error(`Directory not found: ${sanitized || '.'}`);
    }
    return readdirSync(dirPath);
  }

  deleteFile(id: string, relativePath: string): void {
    const sanitized = sanitizeRelativePath(relativePath);
    const wsPath = this.resolveWorkspacePath(id);
    const filePath = ensureWithinWorkspace(wsPath, sanitized);
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${sanitized}`);
    }
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      rmSync(filePath, { recursive: true, force: true });
    } else {
      rmSync(filePath, { force: true });
    }
    logger.info(`File deleted: ${filePath}`);
  }

  // ─── Copy from local ─────────────────────────────────────

  copyFromLocal(id: string, source: string, dest: string): void {
    const sanitizedDest = sanitizeRelativePath(dest);
    const wsPath = this.resolveWorkspacePath(id);
    const destPath = ensureWithinWorkspace(wsPath, sanitizedDest);

    // Validate source is within allowed directories
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

    const stat = statSync(resolvedSource);
    if (stat.isDirectory()) {
      const dirSize = getDirSize(resolvedSource);
      this.assertQuota(wsPath, dirSize, destPath);
      mkdirSync(destPath, { recursive: true });
      cpSync(resolvedSource, destPath, { recursive: true, force: true });
    } else {
      this.assertQuota(wsPath, stat.size, destPath);
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(resolvedSource, destPath);
    }
    logger.info(`Copied from local: ${resolvedSource} → ${destPath}`);
  }

  // ─── Quota helpers ───────────────────────────────────────

  hasWorkspace(id: string): boolean {
    return existsSync(join(this.basePath, sanitizeId(id)));
  }

  getWorkspaceSize(id: string): number {
    const wsPath = this.resolveWorkspacePath(id);
    if (!existsSync(wsPath)) return 0;
    return getDirSize(wsPath);
  }

  resolveWorkspacePath(id: string): string {
    return join(this.basePath, sanitizeId(id));
  }

  assertQuota(wsPath: string, additionalBytes: number, excludingFile?: string): void {
    const currentSize = getDirSize(wsPath);
    // Exclude the file being overwritten so we don't double-count
    let excluding = 0;
    if (excludingFile && existsSync(excludingFile)) {
      try {
        excluding = statSync(excludingFile).size;
      } catch {
        // ignore
      }
    }
    if (currentSize - excluding + additionalBytes > MAX_WORKSPACE_SIZE) {
      throw new Error(
        `Workspace quota exceeded. Current: ${currentSize} bytes, Adding: ${additionalBytes} bytes, Limit: ${MAX_WORKSPACE_SIZE} bytes`
      );
    }
  }
}

export function hashDirectory(dirPath: string): { files: string[]; totalSize: number; sha256: string } {
  const hash = createHash('sha256');
  const files: string[] = [];
  let totalSize = 0;

  function walk(dir: string, relativePrefix: string) {
    const entries = readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
        const content = readFileSync(join(dir, entry.name));
        totalSize += content.length;
        hash.update(relativePath);
        hash.update(content);
      }
    }
  }

  walk(dirPath, '');
  return { files, totalSize, sha256: hash.digest('hex') };
}
