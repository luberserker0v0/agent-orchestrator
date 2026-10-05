import { constants, type Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export interface FileLogOptions {
  directory: string;
  maxFileSizeBytes: number;
  maxRotatedFiles: number;
  retentionMs: number;
}

export type FileLogPruneReason = 'age' | 'count';

export interface FileLogPruneCandidate {
  /** A filename only; absolute paths are deliberately never exposed. */
  artifactId: string;
  lastModifiedAt: number;
  sizeBytes: number;
  reason: FileLogPruneReason;
}

export interface FileLogPruneOutcome extends FileLogPruneCandidate {
  status: 'deleted' | 'failed';
  /** A sanitized filesystem or validation code, never an error message or path. */
  errorCode?: string;
}

export interface FileLogPruneResult {
  scanned: number;
  eligible: number;
  deleted: number;
  failed: number;
  reclaimedBytes: number;
  candidates: FileLogPruneCandidate[];
  outcomes: FileLogPruneOutcome[];
}

export type FileSinkFailureOperation = 'initialize' | 'write' | 'flush' | 'reopen' | 'prune';
export type FileSinkFailureHandler = (operation: FileSinkFailureOperation) => void;

const ACTIVE_LOG_NAME = 'agentorchestrator.jsonl';
const ROTATED_LOG_PATTERN = /^agentorchestrator\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.(\d+)\.(\d+)\.jsonl$/;

interface PruneEntry extends FileLogPruneCandidate {
  dev: number;
  ino: number;
  birthtimeMs: number;
}

interface PrunePlan {
  scanned: number;
  candidates: PruneEntry[];
}

type SinkState = 'new' | 'ready' | 'failed' | 'closed';

/**
 * A single-writer JSONL sink. All filesystem work is serialized so writes,
 * rotation, pruning, reopen, and shutdown cannot interleave.
 */
export class RollingFileSink {
  readonly directory: string;

  private readonly activePath: string;
  private readonly options: FileLogOptions;
  private readonly onFailure?: FileSinkFailureHandler;
  private handle?: FileHandle;
  private handleStats?: Stats;
  private currentSize = 0;
  private rotationCounter = 0;
  private queue: Promise<void> = Promise.resolve();
  private state: SinkState = 'new';
  private acceptingWrites = false;

  constructor(options: FileLogOptions, onFailure?: FileSinkFailureHandler) {
    validateOptions(options);
    this.directory = resolve(options.directory);
    assertNotFilesystemRoot(this.directory);
    this.activePath = join(this.directory, ACTIVE_LOG_NAME);
    this.options = { ...options, directory: this.directory };
    this.onFailure = onFailure;
  }

  /** Initialize and verify the sink. Any failure is intentionally propagated. */
  async initialize(): Promise<void> {
    if (this.state !== 'new') {
      throw new Error('File log sink has already been initialized');
    }

    try {
      await ensureSafeDirectory(this.directory);
      const startupPrune = await this.pruneInternal(Date.now());
      if (startupPrune.failed > 0) {
        throw new Error(`Unable to prune ${startupPrune.failed} rotated log file(s)`);
      }
      await this.openActiveFile();
      this.state = 'ready';
      this.acceptingWrites = true;
    } catch (error) {
      this.state = 'failed';
      this.reportFailure('initialize');
      await this.closeHandleQuietly();
      throw error;
    }
  }

  /** Queue one already-serialized JSON record. */
  write(record: string): void {
    if (!this.acceptingWrites || this.state !== 'ready') return;

    const operation = this.enqueue('write', async () => {
      const line = `${record}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');

      if (this.currentSize > 0 && this.currentSize + bytes > this.options.maxFileSizeBytes) {
        await this.rotate();
      }

      if (!this.handle) throw new Error('File log sink is not open');
      const result = await this.handle.write(line, undefined, 'utf8');
      this.currentSize += result.bytesWritten;
    }, true);

    // write() intentionally remains synchronous for callers. The queue owns
    // the rejection and reports it through the non-recursive failure callback.
    void operation.catch(() => undefined);
  }

  async previewPrune(now: Date = new Date()): Promise<FileLogPruneCandidate[]> {
    this.assertUsable();
    const plan = await this.enqueue('prune', () => this.buildPrunePlan(now.getTime()), false);
    return plan.candidates.map(toPublicCandidate);
  }

  async prune(now: Date = new Date()): Promise<FileLogPruneResult> {
    this.assertUsable();
    return this.enqueue('prune', () => this.pruneInternal(now.getTime()), false);
  }

  async flush(): Promise<void> {
    if (this.state === 'failed' || this.state === 'closed') {
      await this.queue;
      return;
    }
    this.assertUsable();
    await this.enqueue('flush', async () => {
      if (this.handle) await this.handle.sync();
    }, true);
  }

  async reopen(): Promise<void> {
    if (this.state === 'closed') {
      throw new Error('Cannot reopen a closed file log sink');
    }

    this.acceptingWrites = false;
    await this.enqueue('reopen', async () => {
      await this.closeHandle();
      await ensureSafeDirectory(this.directory);
      await this.openActiveFile();
      this.state = 'ready';
      this.acceptingWrites = true;
    }, true, true);
  }

  async close(): Promise<void> {
    if (this.state === 'closed') {
      await this.queue;
      return;
    }

    this.acceptingWrites = false;
    await this.queue;
    try {
      await this.closeHandle();
    } finally {
      this.state = 'closed';
    }
  }

  private assertUsable(): void {
    if (this.state !== 'ready') {
      throw new Error(`File log sink is not ready (${this.state})`);
    }
  }

  private enqueue<T>(
    operationName: FileSinkFailureOperation,
    operation: () => Promise<T>,
    fatal: boolean,
    allowFailed = false,
  ): Promise<T> {
    const result = this.queue.then(async () => {
      if (!allowFailed && this.state !== 'ready') {
        throw new Error(`File log sink is not ready (${this.state})`);
      }
      return operation();
    });

    this.queue = result.then(
      () => undefined,
      async (_error: unknown) => {
        if (fatal) {
          this.acceptingWrites = false;
          this.state = 'failed';
          await this.closeHandleQuietly();
        }
        this.reportFailure(operationName);
      },
    );
    return result;
  }

  private reportFailure(operation: FileSinkFailureOperation): void {
    try {
      this.onFailure?.(operation);
    } catch {
      // Failure reporting must never break logging or recurse into the logger.
    }
  }

  private async openActiveFile(): Promise<void> {
    await ensureSafeDirectory(this.directory);
    const before = await lstatIfExists(this.activePath);
    if (before?.isSymbolicLink() || (before && !before.isFile())) {
      throw new Error('Active log destination must be a regular file');
    }

    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    const handle = await open(
      this.activePath,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
      0o600,
    );

    try {
      const handleStats = await handle.stat();
      const after = await lstat(this.activePath);
      if (!handleStats.isFile() || after.isSymbolicLink() || !after.isFile() || !sameFile(handleStats, after)) {
        throw new Error('Active log destination changed while it was opened');
      }
      await chmod(this.activePath, 0o600);
      this.handle = handle;
      this.handleStats = handleStats;
      this.currentSize = handleStats.size;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private async rotate(): Promise<void> {
    if (!this.handle || !this.handleStats) throw new Error('File log sink is not open');

    await this.handle.sync();
    await this.handle.close();
    this.handle = undefined;

    const current = await lstat(this.activePath);
    if (current.isSymbolicLink() || !current.isFile() || !sameFile(this.handleStats, current)) {
      throw new Error('Active log destination changed before rotation');
    }

    let rotatedPath: string;
    while (true) {
      const name = rotatedName(new Date(), process.pid, this.rotationCounter++);
      rotatedPath = join(this.directory, name);
      if (!(await lstatIfExists(rotatedPath))) break;
    }

    await rename(this.activePath, rotatedPath);
    await chmod(rotatedPath, 0o600);
    this.handleStats = undefined;
    this.currentSize = 0;
    await this.openActiveFile();
    await this.pruneInternal(Date.now());
  }

  private async buildPrunePlan(nowMs: number): Promise<PrunePlan> {
    await assertSafeDirectory(this.directory);
    const entries = await readdir(this.directory, { withFileTypes: true });
    const files: PruneEntry[] = [];

    for (const entry of entries) {
      if (!ROTATED_LOG_PATTERN.test(entry.name) || entry.isSymbolicLink() || !entry.isFile()) continue;
      const candidatePath = join(this.directory, entry.name);
      if (dirname(candidatePath) !== this.directory) continue;

      let candidateStats: Stats;
      try {
        candidateStats = await lstat(candidatePath);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
      if (candidateStats.isSymbolicLink() || !candidateStats.isFile()) continue;

      files.push({
        artifactId: entry.name,
        lastModifiedAt: candidateStats.mtimeMs,
        sizeBytes: candidateStats.size,
        reason: 'age',
        dev: candidateStats.dev,
        ino: candidateStats.ino,
        birthtimeMs: candidateStats.birthtimeMs,
      });
    }

    const byOldest = (a: PruneEntry, b: PruneEntry): number =>
      a.lastModifiedAt - b.lastModifiedAt || a.artifactId.localeCompare(b.artifactId);
    const expired = files
      .filter((entry) => nowMs - entry.lastModifiedAt >= this.options.retentionMs)
      .sort(byOldest);
    const expiredNames = new Set(expired.map((entry) => entry.artifactId));
    const retainedByAge = files
      .filter((entry) => !expiredNames.has(entry.artifactId))
      .sort((a, b) => -byOldest(a, b));
    const excess = retainedByAge
      .slice(this.options.maxRotatedFiles)
      .map((entry) => ({ ...entry, reason: 'count' as const }))
      .sort(byOldest);

    return { scanned: files.length, candidates: [...expired, ...excess] };
  }

  private async pruneInternal(nowMs: number): Promise<FileLogPruneResult> {
    const plan = await this.buildPrunePlan(nowMs);
    const outcomes: FileLogPruneOutcome[] = [];
    let deleted = 0;
    let reclaimedBytes = 0;

    for (const candidate of plan.candidates) {
      const publicCandidate = toPublicCandidate(candidate);
      const candidatePath = join(this.directory, candidate.artifactId);
      try {
        if (dirname(candidatePath) !== this.directory || !ROTATED_LOG_PATTERN.test(candidate.artifactId)) {
          throw taggedError('UNSAFE_ARTIFACT');
        }
        const current = await lstat(candidatePath);
        if (
          current.isSymbolicLink()
          || !current.isFile()
          || !sameFile(candidate, current)
          || current.birthtimeMs !== candidate.birthtimeMs
          || current.mtimeMs !== candidate.lastModifiedAt
          || current.size !== candidate.sizeBytes
        ) {
          throw taggedError('ARTIFACT_CHANGED');
        }
        await unlink(candidatePath);
        deleted += 1;
        reclaimedBytes += candidate.sizeBytes;
        outcomes.push({ ...publicCandidate, status: 'deleted' });
      } catch (error) {
        outcomes.push({
          ...publicCandidate,
          status: 'failed',
          errorCode: errorCode(error) ?? 'UNKNOWN',
        });
      }
    }

    return {
      scanned: plan.scanned,
      eligible: plan.candidates.length,
      deleted,
      failed: plan.candidates.length - deleted,
      reclaimedBytes,
      candidates: plan.candidates.map(toPublicCandidate),
      outcomes,
    };
  }

  private async closeHandle(): Promise<void> {
    const handle = this.handle;
    this.handle = undefined;
    this.handleStats = undefined;
    this.currentSize = 0;
    if (handle) await handle.close();
  }

  private async closeHandleQuietly(): Promise<void> {
    await this.closeHandle().catch(() => undefined);
  }
}

function validateOptions(options: FileLogOptions): void {
  if (typeof options.directory !== 'string' || options.directory.trim().length === 0) {
    throw new Error('File log directory must be a non-empty string');
  }
  if (!Number.isSafeInteger(options.maxFileSizeBytes) || options.maxFileSizeBytes <= 0) {
    throw new Error('File log maxFileSizeBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(options.maxRotatedFiles) || options.maxRotatedFiles < 0) {
    throw new Error('File log maxRotatedFiles must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(options.retentionMs) || options.retentionMs < 0) {
    throw new Error('File log retentionMs must be a non-negative safe integer');
  }
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  await assertExistingPathSegmentsSafe(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertSafeDirectory(directory);
  await chmod(directory, 0o700);
}

async function assertSafeDirectory(directory: string): Promise<void> {
  assertNotFilesystemRoot(directory);
  await assertExistingPathSegmentsSafe(directory);
  const directoryStats = await lstat(directory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error('File log destination must be a real directory');
  }
}

async function assertExistingPathSegmentsSafe(target: string): Promise<void> {
  if (!isAbsolute(target)) throw new Error('Resolved file log path must be absolute');
  const root = parse(target).root;
  let current = root;
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const currentStats = await lstatIfExists(current);
    if (!currentStats) continue;
    if (currentStats.isSymbolicLink() || !currentStats.isDirectory()) {
      throw new Error('File log path contains an unsafe filesystem entry');
    }
  }
}

function assertNotFilesystemRoot(target: string): void {
  const parsed = parse(target);
  if (normalizeForComparison(target) === normalizeForComparison(parsed.root)) {
    throw new Error('Filesystem root cannot be used as the file log directory');
  }
}

async function lstatIfExists(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

function sameFile(left: Pick<Stats, 'dev' | 'ino'>, right: Pick<Stats, 'dev' | 'ino'>): boolean {
  // Some Windows filesystems expose zero inode values. In that case the
  // lstat/type/size/mtime checks still protect rotation and pruning.
  return (left.ino === 0 || right.ino === 0 || left.ino === right.ino) && left.dev === right.dev;
}

function rotatedName(now: Date, pid: number, counter: number): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return `agentorchestrator.${timestamp}.${pid}.${counter}.jsonl`;
}

function toPublicCandidate(entry: PruneEntry): FileLogPruneCandidate {
  return {
    artifactId: entry.artifactId,
    lastModifiedAt: entry.lastModifiedAt,
    sizeBytes: entry.sizeBytes,
    reason: entry.reason,
  };
}

function normalizeForComparison(target: string): string {
  const normalized = resolve(target);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function taggedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export const FILE_LOG_ACTIVE_NAME = ACTIVE_LOG_NAME;
export const FILE_LOG_ROTATED_PATTERN = ROTATED_LOG_PATTERN;
