import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type { WorkspaceConfig } from '../config-loader.js';

export interface WorkspaceOptions {
  model?: string;
  agent?: string;
}

export interface WorkspaceInfo {
  id: string;
  path: string;
  opencodeDir: string;
}

function sanitizeId(raw: string): string {
  // Remove path separators and parent-directory references to prevent traversal
  return raw.replace(/[\\/]/g, '_').replace(/\.{2,}/g, '_');
}

export class WorkspaceFactory {
  private basePath: string;
  private defaultPermissions: Record<string, unknown>;

  constructor(config: WorkspaceConfig) {
    this.basePath = join(process.cwd(), config.basePath);
    this.defaultPermissions = config.defaultPermissions;
  }

  create(id?: string, options?: WorkspaceOptions): WorkspaceInfo {
    const wsId = id ? sanitizeId(id) : randomUUID();
    const wsPath = join(this.basePath, wsId);
    const opencodeDir = join(wsPath, '.opencode');

    mkdirSync(opencodeDir, { recursive: true });

    const opencodeConfig: Record<string, unknown> = {
      $schema: 'https://opencode.ai/config.json',
      permission: this.defaultPermissions,
    };

    if (options?.model) {
      opencodeConfig.model = options.model;
    }

    if (options?.agent) {
      opencodeConfig.agent = options.agent;
    }

    writeFileSync(
      join(opencodeDir, 'opencode.json'),
      JSON.stringify(opencodeConfig, null, 2),
      'utf-8'
    );

    logger.info(`Workspace created: ${wsPath}`);
    return { id: wsId, path: wsPath, opencodeDir };
  }

  destroy(id: string): void {
    // 實際刪除在 instance-manager 中處理，避免 rm -rf 的複雜性
    logger.info(`Workspace destroy requested: ${id}`);
  }
}
