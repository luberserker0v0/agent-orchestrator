import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

function transactionPath(targetPath: string, kind: 'stage' | 'backup'): string {
  return join(
    dirname(targetPath),
    `.${basename(targetPath)}.${kind}.${process.pid}.${randomUUID()}`,
  );
}

/**
 * Populate a sibling staging directory before replacing the destination.
 * Failures before the replacement leave the prior destination untouched;
 * failures during the swap restore it before the original error is raised.
 */
export function replaceDirectorySync(
  targetPath: string,
  populate: (stagingPath: string) => void,
): void {
  const parentPath = dirname(targetPath);
  const stagingPath = transactionPath(targetPath, 'stage');
  const backupPath = transactionPath(targetPath, 'backup');
  let originalMoved = false;
  let replacementInstalled = false;

  mkdirSync(parentPath, { recursive: true });
  mkdirSync(stagingPath, { mode: 0o700 });

  try {
    populate(stagingPath);

    if (existsSync(targetPath)) {
      if (lstatSync(targetPath).isSymbolicLink()) {
        throw new Error('Unsafe path: symbolic links are not allowed for managed skill directories');
      }
      renameSync(targetPath, backupPath);
      originalMoved = true;
    }

    try {
      renameSync(stagingPath, targetPath);
      replacementInstalled = true;
    } catch (error) {
      if (originalMoved && !existsSync(targetPath) && existsSync(backupPath)) {
        try {
          renameSync(backupPath, targetPath);
          originalMoved = false;
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            'Failed to install the staged directory and restore the previous directory',
            { cause: restoreError },
          );
        }
      }
      throw error;
    }

    if (originalMoved) {
      rmSync(backupPath, { recursive: true, force: true });
      originalMoved = false;
    }
  } finally {
    try {
      rmSync(stagingPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup must not replace the transaction error.
    }
    if (!replacementInstalled && originalMoved && !existsSync(targetPath) && existsSync(backupPath)) {
      try {
        renameSync(backupPath, targetPath);
      } catch {
        // The primary/aggregate error above carries the actionable failure.
      }
    }
  }
}
