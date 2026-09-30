import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { logger } from '../utils/logger.js';
import type { SessionStorageConfig } from '../config-loader.js';

export interface ResolvedSessionStorage {
  /** Absolute per-conversation data-dir: `<sharedRoot>/<sanitized id>` */
  sessionDir: string;
  /** Env vars to inject into the opencode server process */
  env: Record<string, string>;
}

/**
 * Sanitize a conversation id for use as a single path segment.
 * Mirrors WorkspaceFactory.sanitizeId so both sides agree on the layout.
 */
export function sanitizeSessionId(id: string): string {
  return id.replace(/[\\/]/g, '_').replace(/\.{2,}/g, '_');
}

/**
 * Resolve (and create) the per-conversation opencode data-dir for `id`.
 * Layout matches the plan: `<sharedRoot>/<id>/` holds the whole opencode tree
 * (`xdg` mode) with an optional single-file override (`sqlite` mode).
 * Throws with a clear message when the directory cannot be prepared — the
 * caller must fail instance startup rather than boot a blank session over
 * existing user data.
 */
export function resolveSessionStorage(
  config: SessionStorageConfig,
  id: string,
): ResolvedSessionStorage {
  const mode = config.mode ?? 'xdg';
  const root = resolve(process.cwd(), config.sharedRoot);
  const sessionDir = join(root, sanitizeSessionId(id));
  try {
    mkdirSync(sessionDir, { recursive: true });
  } catch (err) {
    throw new Error(
      `Failed to prepare session storage dir "${sessionDir}": ${(err as Error).message}`,
      { cause: err },
    );
  }
  const env: Record<string, string> = { XDG_DATA_HOME: sessionDir };
  if (mode === 'sqlite') {
    env.OPENCODE_DB = join(sessionDir, 'opencode.db');
  }
  logger.debug(`Session storage for ${id}: ${sessionDir} (mode: ${mode})`);
  return { sessionDir, env };
}

/** Container mount point for the per-conversation session dir inside instance containers. */
export const SESSION_CONTAINER_MOUNT = '/opencode-data';

/**
 * Build `docker run` args mounting the resolved session dir into the instance
 * container and pointing the opencode server at it. Keeps the `/workspace`
 * mount untouched.
 */
export function sessionContainerArgs(resolved: ResolvedSessionStorage): string[] {
  const args = ['-v', `${resolved.sessionDir}:${SESSION_CONTAINER_MOUNT}`, '-e', `XDG_DATA_HOME=${SESSION_CONTAINER_MOUNT}`];
  if (resolved.env.OPENCODE_DB !== undefined) {
    args.push('-e', `OPENCODE_DB=${SESSION_CONTAINER_MOUNT}/opencode.db`);
  }
  return args;
}
