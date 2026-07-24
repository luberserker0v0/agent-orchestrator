import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { WorkspaceConfig } from '../config-loader.js';
import type { OpencodeConfig } from '../opencode-http/types.js';
import type { StorageBackend } from '../storage/index.js';
import type { RuntimeAccess } from '../storage/types.js';

export interface WorkspaceInfo {
  id: string;
  path: string;
  opencodeDir: string;
  runtimeAccess: RuntimeAccess;
}

const DEFAULT_MAX_WORKSPACE_SIZE = 50 * 1024 * 1024; // 50 MB

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

export function validateAgentName(name: string): string {
  if (!name || typeof name !== 'string') {
    throw new Error('Invalid agent name');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name)) {
    throw new Error('Invalid agent name');
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

export class WorkspaceFactory {
  private basePath: string;
  private storage: StorageBackend;
  private canonicalConfig: Record<string, unknown>;
  private enforceCanonicalConfig: boolean;
  private maxSizeBytes: number;
  private allowedCopySources: string[];

  constructor(config: WorkspaceConfig, storage: StorageBackend, canonicalConfig?: Record<string, unknown>) {
    this.basePath = resolve(process.cwd(), config.basePath);
    this.storage = storage;
    this.enforceCanonicalConfig = config.enforceCanonicalConfig;
    this.maxSizeBytes = config.maxSizeBytes ?? DEFAULT_MAX_WORKSPACE_SIZE;
    this.canonicalConfig = canonicalConfig ?? {};
    this.allowedCopySources = [
      join(process.cwd(), 'assets'),
      join(process.cwd(), 'templates'),
      join(process.cwd(), 'skills'),
    ];
  }

  async create(id?: string, agentType?: string): Promise<WorkspaceInfo> {
    const wsId = id ? sanitizeId(id) : randomUUID();
    const wsPath = join(this.basePath, wsId);
    const opencodeDir = join(wsPath, '.opencode');

    await this.storage.createWorkspaceDir(wsId);
    await this.storage.ensureDir(wsId, '.opencode');

    logger.info(`Workspace created: ${wsPath}${agentType ? ` (agent: ${agentType})` : ''}`);
    return {
      id: wsId,
      path: wsPath,
      opencodeDir,
      runtimeAccess: this.storage.getRuntimeAccess(wsId),
    };
  }

  async ensure(id: string): Promise<WorkspaceInfo> {
    const wsId = sanitizeId(id);
    const wsPath = join(this.basePath, wsId);
    const opencodeDir = join(wsPath, '.opencode');
    if (!await this.storage.hasWorkspace(wsId)) {
      await this.storage.createWorkspaceDir(wsId);
      await this.storage.ensureDir(wsId, '.opencode');
    }
    return {
      id: wsId,
      path: wsPath,
      opencodeDir,
      runtimeAccess: { type: 'local', cwd: wsPath },
    };
  }

  async destroy(id: string): Promise<void> {
    const wsId = sanitizeId(id);
    const wsPath = join(this.basePath, wsId);
    if (await this.storage.hasWorkspace(wsId)) {
      try {
        await this.storage.destroyWorkspace(wsId);
        logger.info(`Workspace destroyed: ${wsPath}`);
      } catch (err) {
        logger.warn(`Failed to destroy workspace: ${wsPath}`, err);
      }
    } else {
      logger.warn(`Workspace not found for destruction: ${wsPath}`);
    }
  }

  async cleanupOrphans(): Promise<void> {
    await this.storage.cleanupOrphans();
  }

  // ─── Config ──────────────────────────────────────────────

  async writeConfig(id: string, config: OpencodeConfig): Promise<void> {
    const wsId = sanitizeId(id);

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

    await this.storage.writeFile(wsId, '.opencode/opencode.json', JSON.stringify(result, null, 2));
    logger.info(`Config written for workspace: ${this.resolveWorkspacePath(id)}`);
  }

  async readConfig(id: string): Promise<OpencodeConfig> {
    const wsId = sanitizeId(id);
    try {
      const raw = await this.storage.readFile(wsId, '.opencode/opencode.json');
      return JSON.parse(raw.toString('utf-8')) as OpencodeConfig;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  // ─── Generic Files ───────────────────────────────────────

  async writeFile(id: string, relativePath: string, content: string): Promise<void> {
    const wsId = sanitizeId(id);
    const sanitized = sanitizeRelativePath(relativePath);
    const size = Buffer.byteLength(content, 'utf-8');
    await this.assertQuota(wsId, size);
    await this.storage.writeFile(wsId, sanitized, content);
    logger.info(`File written: ${this.resolveWorkspacePath(id)}/${sanitized}`);
  }

  async readFile(id: string, relativePath: string): Promise<string> {
    const wsId = sanitizeId(id);
    const sanitized = sanitizeRelativePath(relativePath);
    const raw = await this.storage.readFile(wsId, sanitized);
    return raw.toString('utf-8');
  }

  async listFiles(id: string, relativePath = ''): Promise<string[]> {
    const wsId = sanitizeId(id);
    const sanitized = relativePath ? sanitizeRelativePath(relativePath) : '';
    return this.storage.listEntries(wsId, sanitized);
  }

  async deleteFile(id: string, relativePath: string): Promise<void> {
    const wsId = sanitizeId(id);
    const sanitized = sanitizeRelativePath(relativePath);
    await this.storage.deleteEntry(wsId, sanitized);
    logger.info(`File deleted: ${this.resolveWorkspacePath(id)}/${sanitized}`);
  }

  // ─── Copy from local ─────────────────────────────────────

  async copyFromLocal(id: string, source: string, dest: string): Promise<void> {
    const wsId = sanitizeId(id);
    const sanitizedDest = sanitizeRelativePath(dest);

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

    const srcStat = statSync(resolvedSource);
    if (srcStat.isDirectory()) {
      const dirSize = getDirSize(resolvedSource);
      await this.assertQuota(wsId, dirSize);
      await this.storage.copyToStorageRecursive(wsId, resolvedSource, sanitizedDest);
    } else {
      await this.assertQuota(wsId, srcStat.size);
      await this.storage.copyToStorage(wsId, resolvedSource, sanitizedDest);
    }
    logger.info(`Copied from local: ${resolvedSource} → ${this.resolveWorkspacePath(id)}/${sanitizedDest}`);
  }

  // ─── Quota helpers ───────────────────────────────────────

  getMaxSizeBytes(): number {
    return this.maxSizeBytes;
  }

  async hasWorkspace(id: string): Promise<boolean> {
    return this.storage.hasWorkspace(sanitizeId(id));
  }

  async getWorkspaceSize(id: string): Promise<number> {
    return this.storage.getWorkspaceSize(sanitizeId(id));
  }

  resolveWorkspacePath(id: string): string {
    return join(this.basePath, sanitizeId(id));
  }

  async assertQuota(wsId: string, additionalBytes: number): Promise<void> {
    if (this.maxSizeBytes === 0) return;
    const currentSize = await this.storage.getWorkspaceSize(wsId);
    if (currentSize + additionalBytes > this.maxSizeBytes) {
      throw new Error(
        `Workspace quota exceeded. Current: ${currentSize} bytes, Adding: ${additionalBytes} bytes, Limit: ${this.maxSizeBytes} bytes`
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
