import { mkdir, readFile, readdir, rm, copyFile } from 'node:fs/promises';
import { existsSync, lstatSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import type { StorageBackend, RuntimeAccess } from './types.js';
import { resolvePathWithoutSymlinks } from './path-safety.js';
import { atomicWriteFile } from './atomic-file.js';

function sanitizeId(raw: string): string {
  return raw.replace(/[\\/]/g, '_').replace(/\.{2,}/g, '_');
}

async function retryRm(dirPath: string, maxRetries = 3, baseDelay = 500): Promise<void> {
  let lastErr: Error | undefined;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await rm(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err as Error;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') throw err;
      if (i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, Math.min(baseDelay * Math.pow(2, i), 2000)));
      }
    }
  }
  throw lastErr;
}

function getDirSize(dirPath: string): number {
  let total = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) total += getDirSize(fullPath);
      else if (!entry.isSymbolicLink()) total += statSync(fullPath).size;
    }
  } catch { /* ignore */ }
  return total;
}

export class LocalStorage implements StorageBackend {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = resolve(process.cwd(), basePath);
  }

  private wsPath(workspaceId: string): string {
    return resolvePathWithoutSymlinks(this.basePath, sanitizeId(workspaceId));
  }

  private resolvePath(workspaceId: string, relativePath: string): string {
    return resolvePathWithoutSymlinks(this.basePath, sanitizeId(workspaceId), relativePath);
  }

  async createWorkspaceDir(workspaceId: string): Promise<void> {
    await mkdir(this.wsPath(workspaceId), { recursive: true });
  }

  async ensureWorkspaceDir(workspaceId: string): Promise<void> {
    await mkdir(this.wsPath(workspaceId), { recursive: true });
  }

  async destroyWorkspace(workspaceId: string): Promise<void> {
    const p = this.wsPath(workspaceId);
    if (existsSync(p)) {
      await retryRm(p);
    }
  }

  async hasWorkspace(workspaceId: string): Promise<boolean> {
    return existsSync(this.wsPath(workspaceId));
  }

  async ensureDir(workspaceId: string, relativePath: string): Promise<void> {
    await mkdir(this.resolvePath(workspaceId, relativePath), { recursive: true });
  }

  async readFile(workspaceId: string, relativePath: string): Promise<Buffer> {
    return readFile(this.resolvePath(workspaceId, relativePath));
  }

  async writeFile(workspaceId: string, relativePath: string, content: string | Buffer): Promise<void> {
    const p = this.resolvePath(workspaceId, relativePath);
    await mkdir(join(p, '..'), { recursive: true });
    await atomicWriteFile(p, content);
  }

  async listEntries(workspaceId: string, relativePath?: string): Promise<string[]> {
    const p = relativePath ? this.resolvePath(workspaceId, relativePath) : this.wsPath(workspaceId);
    return readdir(p);
  }

  async deleteEntry(workspaceId: string, relativePath: string): Promise<void> {
    const p = this.resolvePath(workspaceId, relativePath);
    if (!existsSync(p)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    await rm(p, { recursive: true, force: true });
  }

  async getEntrySize(workspaceId: string, relativePath: string): Promise<number> {
    try {
      const path = this.resolvePath(workspaceId, relativePath);
      if (lstatSync(path).isSymbolicLink()) {
        throw new Error('Unsafe path: symbolic links are not allowed in managed workspace paths');
      }
      return statSync(path).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
  }

  async getWorkspaceSize(workspaceId: string): Promise<number> {
    const p = this.wsPath(workspaceId);
    if (!existsSync(p)) return 0;
    return getDirSize(p);
  }

  async cleanupOrphans(): Promise<void> {
    if (!existsSync(this.basePath)) return;
    // Conversation workspaces are durable. Only remove explicitly marked
    // temporary artifacts left behind by interrupted atomic operations.
    const entries = readdirSync(this.basePath).filter(entry => entry.startsWith('.tmp-'));
    for (const entry of entries) {
      const fullPath = join(this.basePath, entry);
      try {
        rmSync(fullPath, { recursive: true, force: true });
      } catch (err) {
        logger.error(`Failed to remove orphan: ${fullPath}`, err);
      }
    }
    logger.info(`Cleaned up ${entries.length} orphan workspace(s)`);
  }

  async copyToStorage(workspaceId: string, sourceLocalPath: string, destRelativePath: string): Promise<void> {
    const dest = this.resolvePath(workspaceId, destRelativePath);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(sourceLocalPath, dest);
  }

  async copyToStorageRecursive(workspaceId: string, sourceLocalDir: string, destRelativeRoot: string): Promise<void> {
    const entries = readdirSync(sourceLocalDir, { withFileTypes: true });
    for (const entry of entries) {
      const src = join(sourceLocalDir, entry.name);
      const rel = destRelativeRoot ? `${destRelativeRoot}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await this.copyToStorageRecursive(workspaceId, src, rel);
      } else if (entry.isFile()) {
        await this.copyToStorage(workspaceId, src, rel);
      }
    }
  }

  getRuntimeAccess(workspaceId: string): RuntimeAccess {
    return { type: 'local', cwd: this.wsPath(workspaceId) };
  }
}
