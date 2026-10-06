import { randomUUID } from 'node:crypto';
import {
  existsSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const DEFAULT_FILE_MODE = 0o600;

function temporaryPath(targetPath: string): string {
  return join(
    dirname(targetPath),
    `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
}

function currentModeSync(targetPath: string): number {
  return existsSync(targetPath)
    ? statSync(targetPath).mode & 0o777
    : DEFAULT_FILE_MODE;
}

async function currentMode(targetPath: string): Promise<number> {
  try {
    return (await stat(targetPath)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_FILE_MODE;
    throw error;
  }
}

/**
 * Replace a file using a same-directory temporary file so readers observe
 * either the old complete contents or the new complete contents.
 */
export function atomicWriteFileSync(targetPath: string, content: string | Buffer): void {
  const tempPath = temporaryPath(targetPath);
  try {
    writeFileSync(tempPath, content, {
      encoding: typeof content === 'string' ? 'utf8' : undefined,
      flag: 'wx',
      mode: currentModeSync(targetPath),
    });
    renameSync(tempPath, targetPath);
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup must not replace the original write failure.
    }
  }
}

/** Async counterpart to atomicWriteFileSync. */
export async function atomicWriteFile(targetPath: string, content: string | Buffer): Promise<void> {
  const tempPath = temporaryPath(targetPath);
  try {
    await writeFile(tempPath, content, {
      encoding: typeof content === 'string' ? 'utf8' : undefined,
      flag: 'wx',
      mode: await currentMode(targetPath),
    });
    await rename(tempPath, targetPath);
  } finally {
    try {
      await rm(tempPath, { force: true });
    } catch {
      // Best-effort cleanup must not replace the original write failure.
    }
  }
}
