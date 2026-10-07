import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  createSessionOwnershipRecord,
  deleteManagedSessionStorage,
  listSessionOwnershipRecordFiles,
  markSessionStorageDeletePending,
  readSessionOwnershipRecord,
  resolveSessionStorageLayout,
  sessionQuarantinePath,
  writeSessionOwnershipRecord,
} from '../agent-runtime/session-storage.js';
import { isValidConversationId } from '../utils/conversation-id.js';
import { ErrorCodes } from '../utils/errors.js';
import type { SessionStorageConfig } from '../config-loader.js';
import type { CleanupArtifact, CleanupArtifactResult, CleanupProvider } from './types.js';
import type { SessionOwnershipRecord } from '../agent-runtime/session-storage.js';

export interface LocalPersistentDataRoot {
  runtimeId: string;
  config: SessionStorageConfig;
}

export interface LocalPersistentDataProviderOptions {
  /** Enables first-observed orphan enrollment and grace-period reaping. */
  enabled: boolean;
  /** Retry durable explicit-delete tombstones even when orphan reaping is disabled. */
  retryPendingDeletes?: boolean;
  ownerId: string;
  gracePeriodMs: number;
  roots: LocalPersistentDataRoot[];
  /** True when a conversation, workspace, or runtime instance still owns the id. */
  isProtected: (conversationId: string) => boolean | Promise<boolean>;
  /** A delete-pending generation may be purged only after its runtime is gone. */
  isRuntimeActive?: (conversationId: string) => boolean | Promise<boolean>;
  /** Optional lifecycle serializer used for the final check-and-delete sequence. */
  withConversationLock?: <T>(conversationId: string, operation: () => Promise<T>) => Promise<T>;
}

type LocalAction = 'none' | 'enroll' | 'mark' | 'clear' | 'delete' | 'error';

interface RootContext {
  config: SessionStorageConfig;
  runtimeId?: string;
  rootKey: string;
}

interface ScannedArtifact {
  artifact: CleanupArtifact;
  action: LocalAction;
  root?: RootContext;
  record?: SessionOwnershipRecord;
  errorMessage?: string;
}

interface RecordScan {
  artifacts: ScannedArtifact[];
  recordedIds: Set<string>;
  recordedArtifactIds: Set<string>;
  controlsSafe: boolean;
}

/** Periodic cleanup provider for Direct/Docker per-conversation session roots. */
export class LocalPersistentDataProvider implements CleanupProvider {
  readonly target = 'persistentData' as const;
  readonly backend = 'filesystem' as const;
  readonly enabled: boolean;

  private readonly orphanCleanupEnabled: boolean;
  private readonly ownerId: string;
  private readonly gracePeriodMs: number;
  private readonly roots: RootContext[];
  private readonly isProtected: LocalPersistentDataProviderOptions['isProtected'];
  private readonly isRuntimeActive: NonNullable<LocalPersistentDataProviderOptions['isRuntimeActive']>;
  private readonly withConversationLock: NonNullable<LocalPersistentDataProviderOptions['withConversationLock']>;

  constructor(options: LocalPersistentDataProviderOptions) {
    this.orphanCleanupEnabled = options.enabled;
    this.ownerId = options.ownerId.trim();
    this.gracePeriodMs = options.gracePeriodMs;
    this.isProtected = options.isProtected;
    this.isRuntimeActive = options.isRuntimeActive ?? (() => false);
    this.withConversationLock = options.withConversationLock
      ?? (async <T>(_id: string, operation: () => Promise<T>) => operation());
    this.roots = deduplicateRoots(options.roots);
    this.enabled = this.roots.length > 0
      && (this.orphanCleanupEnabled || options.retryPendingDeletes === true);

    if (this.enabled && !this.ownerId) {
      throw new Error('Local persistent-data cleanup requires a non-empty ownerId');
    }
    if (!Number.isSafeInteger(this.gracePeriodMs) || this.gracePeriodMs <= 0) {
      throw new Error('Local persistent-data cleanup gracePeriodMs must be a positive safe integer');
    }
  }

  async preview(now: number): Promise<CleanupArtifact[]> {
    if (!this.enabled) return [];
    return (await this.scan(now)).map(item => item.artifact);
  }

  async run(now: number): Promise<CleanupArtifactResult[]> {
    if (!this.enabled) return [];
    const scanned = await this.scan(now);
    const results: CleanupArtifactResult[] = [];
    for (const item of scanned) {
      results.push(await this.execute(item, now));
    }
    return results;
  }

  private async scan(now: number): Promise<ScannedArtifact[]> {
    const artifacts: ScannedArtifact[] = [];
    for (const root of this.roots) {
      artifacts.push(...await this.scanRoot(root, now));
    }
    return artifacts;
  }

  private async scanRoot(root: RootContext, now: number): Promise<ScannedArtifact[]> {
    let layout: ReturnType<typeof resolveSessionStorageLayout>;
    try {
      layout = resolveSessionStorageLayout(root.config);
    } catch {
      return [opaqueArtifact(root, 'unsafe-storage-root', 'error')];
    }
    if (!existsSync(layout.root)) return [];
    if (!isPlainDirectory(layout.root)) {
      return [opaqueArtifact(root, 'unsafe-storage-root', 'error')];
    }

    const records = await this.scanOwnershipRecords(root, layout, now);
    if (!this.orphanCleanupEnabled) return records.artifacts;
    const directories = await this.scanUntrackedDirectories(
      root,
      layout,
      records.recordedIds,
      records.controlsSafe,
    );
    const quarantine = this.scanQuarantine(root, layout, records.recordedArtifactIds);
    return [...records.artifacts, ...directories, ...quarantine];
  }

  private async scanOwnershipRecords(
    root: RootContext,
    layout: ReturnType<typeof resolveSessionStorageLayout>,
    now: number,
  ): Promise<RecordScan> {
    const artifacts: ScannedArtifact[] = [];
    const recordedIds = new Set<string>();
    const recordedArtifactIds = new Set<string>();
    let controlsSafe = true;
    let recordFiles: string[] = [];
    try {
      recordFiles = listSessionOwnershipRecordFiles(root.config);
    } catch {
      controlsSafe = false;
      artifacts.push(opaqueArtifact(root, 'unsafe-records-directory', 'error'));
    }

    for (const file of recordFiles) {
      const id = file.endsWith('.json') ? file.slice(0, -5) : '';
      if (!id || !isValidConversationId(id)) {
        artifacts.push(opaqueArtifact(root, 'malformed-record-name', 'none', file));
        continue;
      }
      recordedIds.add(id);
      const recordPath = join(layout.recordsDir, file);
      if (!isPlainFile(recordPath)) {
        artifacts.push(conversationArtifact(root, id, opaqueId('record', root.rootKey, id), {
          state: 'untracked',
          reason: 'unsafe-record-entry',
          sizeBytes: null,
        }, 'none'));
        continue;
      }
      let record: SessionOwnershipRecord;
      try {
        const parsed = readSessionOwnershipRecord(root.config, id);
        if (!parsed) throw new Error('record disappeared');
        record = parsed;
      } catch {
        artifacts.push(conversationArtifact(root, id, opaqueId('record', root.rootKey, id), {
          state: 'untracked',
          reason: 'malformed-ownership-record',
          sizeBytes: null,
        }, 'none'));
        continue;
      }
      recordedArtifactIds.add(record.artifactId);
      if (!this.orphanCleanupEnabled && record.state !== 'delete-pending') continue;
      artifacts.push(await this.classifyRecord(root, record, now));
    }
    return { artifacts, recordedIds, recordedArtifactIds, controlsSafe };
  }

  private async scanUntrackedDirectories(
    root: RootContext,
    layout: ReturnType<typeof resolveSessionStorageLayout>,
    recordedIds: Set<string>,
    controlsSafe: boolean,
  ): Promise<ScannedArtifact[]> {
    const artifacts: ScannedArtifact[] = [];
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(layout.root, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      artifacts.push(opaqueArtifact(root, 'unreadable-storage-root', 'error'));
      return artifacts;
    }
    for (const entry of entries) {
      if (entry.name === basename(layout.controlDir) || recordedIds.has(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        artifacts.push(opaqueArtifact(root, 'unsafe-symbolic-link', 'none', entry.name));
        continue;
      }
      if (!isValidConversationId(entry.name)) {
        artifacts.push(opaqueArtifact(root, 'invalid-storage-entry', 'none', entry.name));
        continue;
      }
      const sessionDir = join(layout.root, entry.name);
      if (!entry.isDirectory() || !isPlainDirectory(sessionDir)) {
        artifacts.push(conversationArtifact(root, entry.name, opaqueId('untracked', root.rootKey, entry.name), {
          state: 'untracked',
          reason: 'unsafe-session-entry',
          sizeBytes: null,
        }, 'none'));
        continue;
      }
      if (!controlsSafe) {
        artifacts.push(conversationArtifact(root, entry.name, opaqueId('untracked', root.rootKey, entry.name), {
          state: 'untracked',
          reason: 'unsafe-cleanup-controls',
          sizeBytes: safeDirectorySize(sessionDir),
        }, 'none'));
        continue;
      }
      let protectedId: boolean;
      try {
        protectedId = await this.isProtected(entry.name);
      } catch {
        artifacts.push(conversationArtifact(root, entry.name, opaqueId('untracked', root.rootKey, entry.name), {
          state: 'untracked',
          reason: 'protection-check-failed',
          sizeBytes: safeDirectorySize(sessionDir),
        }, 'error', undefined, 'Unable to verify conversation ownership'));
        continue;
      }
      artifacts.push(conversationArtifact(root, entry.name, opaqueId('untracked', root.rootKey, entry.name), {
        state: 'untracked',
        reason: protectedId
          ? 'protected-untracked-session'
          : this.orphanCleanupEnabled ? 'untracked-session-data' : 'orphan-cleanup-disabled',
        sizeBytes: safeDirectorySize(sessionDir),
        lastModifiedAt: safeModifiedAt(sessionDir),
      }, protectedId || !this.orphanCleanupEnabled ? 'none' : 'enroll'));
    }
    return artifacts;
  }

  private scanQuarantine(
    root: RootContext,
    layout: ReturnType<typeof resolveSessionStorageLayout>,
    recordedArtifactIds: Set<string>,
  ): ScannedArtifact[] {
    if (!existsSync(layout.quarantineDir)) return [];
    if (!isPlainDirectory(layout.quarantineDir)) {
      return [opaqueArtifact(root, 'unsafe-quarantine-directory', 'error')];
    }

    const artifacts: ScannedArtifact[] = [];
    for (const entry of readdirSync(layout.quarantineDir, { withFileTypes: true })) {
      if (recordedArtifactIds.has(entry.name)) continue;
      artifacts.push(opaqueArtifact(
        root,
        entry.isSymbolicLink() ? 'unsafe-quarantine-entry' : 'unowned-quarantine-entry',
        'none',
        entry.name,
      ));
    }
    return artifacts;
  }

  private async classifyRecord(
    root: RootContext,
    record: SessionOwnershipRecord,
    now: number,
  ): Promise<ScannedArtifact> {
    const layout = resolveSessionStorageLayout(root.config);
    const sessionDir = join(layout.root, record.conversationId);
    const quarantineDir = sessionQuarantinePath(root.config, record.artifactId);
    const existingPath = existsSync(sessionDir) ? sessionDir : existsSync(quarantineDir) ? quarantineDir : undefined;
    const base = {
      sizeBytes: existingPath ? safeDirectorySize(existingPath) : 0,
      ...(existingPath ? { lastModifiedAt: safeModifiedAt(existingPath) } : {}),
    };

    if (record.ownerId !== this.ownerId) {
      return conversationArtifact(root, record.conversationId, record.artifactId, {
        state: 'untracked',
        reason: 'foreign-owner',
        sizeBytes: null,
      }, 'none', record);
    }
    if ((existsSync(sessionDir) && !isPlainDirectory(sessionDir))
      || (existsSync(quarantineDir) && !isPlainDirectory(quarantineDir))) {
      return conversationArtifact(root, record.conversationId, record.artifactId, {
        state: 'untracked',
        reason: 'unsafe-managed-entry',
        sizeBytes: null,
      }, 'none', record);
    }

    // A durable explicit-delete marker is authoritative. Same-ID reuse is
    // blocked by the storage record, so stale workspace/runtime authority (or
    // an unavailable protection check) must not strand the tombstone.
    if (record.state === 'delete-pending') {
      try {
        if (await this.isRuntimeActive(record.conversationId)) {
          return conversationArtifact(root, record.conversationId, record.artifactId, {
            state: 'pending',
            reason: 'runtime-instance-present',
            ...base,
          }, 'none', record);
        }
      } catch {
        return conversationArtifact(root, record.conversationId, record.artifactId, {
          state: 'pending',
          reason: 'runtime-check-failed',
          sizeBytes: base.sizeBytes,
        }, 'error', record, 'Unable to verify that the runtime stopped');
      }
      return conversationArtifact(root, record.conversationId, record.artifactId, {
        state: 'eligible',
        reason: 'delete-pending-retry',
        ...base,
      }, 'delete', record);
    }

    let protectedId: boolean;
    try {
      protectedId = await this.isProtected(record.conversationId);
    } catch {
      return conversationArtifact(root, record.conversationId, record.artifactId, {
        state: 'untracked',
        reason: 'protection-check-failed',
        sizeBytes: base.sizeBytes,
      }, 'error', record, 'Unable to verify conversation ownership');
    }

    if (!this.orphanCleanupEnabled) {
      return conversationArtifact(root, record.conversationId, record.artifactId, {
        state: record.state === 'orphan-candidate' ? 'pending' : 'untracked',
        reason: 'orphan-cleanup-disabled',
        ...base,
        ...(record.state === 'orphan-candidate' ? {
          firstObservedAt: record.stateSince,
          eligibleAt: record.stateSince + this.gracePeriodMs,
        } : {}),
      }, 'none', record);
    }
    if (protectedId) {
      return conversationArtifact(root, record.conversationId, record.artifactId, {
        state: record.state === 'orphan-candidate' ? 'pending' : 'untracked',
        reason: record.state === 'orphan-candidate' ? 'ownership-restored' : 'protected-session',
        ...base,
        ...(record.state === 'orphan-candidate' ? { firstObservedAt: record.stateSince } : {}),
      }, record.state === 'orphan-candidate' ? 'clear' : 'none', record);
    }
    if (record.state === 'active') {
      return conversationArtifact(root, record.conversationId, record.artifactId, {
        state: 'untracked',
        reason: 'orphan-first-observation',
        ...base,
      }, 'mark', record);
    }

    const eligibleAt = record.stateSince + this.gracePeriodMs;
    return conversationArtifact(root, record.conversationId, record.artifactId, {
      state: now >= eligibleAt ? 'eligible' : 'pending',
      reason: now >= eligibleAt ? 'orphan-grace-expired' : 'orphan-grace-period',
      ...base,
      firstObservedAt: record.stateSince,
      eligibleAt,
    }, now >= eligibleAt ? 'delete' : 'none', record);
  }

  private async execute(item: ScannedArtifact, now: number): Promise<CleanupArtifactResult> {
    if (item.action === 'none') return result(item.artifact, 'skipped');
    if (item.action === 'error') {
      return result(item.artifact, 'failed', ErrorCodes.CLEANUP_FAILED, item.errorMessage ?? 'Cleanup safety check failed');
    }
    if (!item.root || !item.artifact.conversationId) {
      return result(item.artifact, 'failed', ErrorCodes.CLEANUP_FAILED, 'Cleanup artifact context is incomplete');
    }
    const id = item.artifact.conversationId;
    try {
      return await this.withConversationLock(id, async () => {
        if (item.action === 'enroll') return this.enroll(item, now);
        const current = readSessionOwnershipRecord(item.root!.config, id);
        if (!current || current.artifactId !== item.record?.artifactId || current.ownerId !== this.ownerId) {
          return result(item.artifact, 'skipped');
        }
        if (item.action === 'mark') return this.mark(item, current, now);
        if (item.action === 'clear') return this.clear(item, current, now);
        return this.delete(item, current, now);
      });
    } catch (err) {
      const code = err instanceof Error && 'code' in err && typeof err.code === 'string'
        ? err.code
        : ErrorCodes.CLEANUP_FAILED;
      return result(item.artifact, 'failed', code, 'Persistent session cleanup failed');
    }
  }

  private async enroll(item: ScannedArtifact, now: number): Promise<CleanupArtifactResult> {
    const root = item.root!;
    const id = item.artifact.conversationId!;
    if (await this.isProtected(id) || readSessionOwnershipRecord(root.config, id)) {
      return result(item.artifact, 'skipped');
    }
    const sessionDir = join(resolveSessionStorageLayout(root.config).root, id);
    if (!existsSync(sessionDir) || !isPlainDirectory(sessionDir)) {
      return result(item.artifact, 'skipped');
    }
    const record = createSessionOwnershipRecord(id, this.ownerId, 'orphan-candidate', now);
    writeSessionOwnershipRecord(root.config, record);
    return result({
      ...item.artifact,
      artifactId: record.artifactId,
      state: 'pending',
      reason: 'orphan-candidate-marked',
      firstObservedAt: now,
      eligibleAt: now + this.gracePeriodMs,
    }, 'marked');
  }

  private async mark(
    item: ScannedArtifact,
    current: SessionOwnershipRecord,
    now: number,
  ): Promise<CleanupArtifactResult> {
    if (current.state !== 'active' || await this.isProtected(current.conversationId)) {
      return result(item.artifact, 'skipped');
    }
    writeSessionOwnershipRecord(item.root!.config, {
      ...current,
      state: 'orphan-candidate',
      stateSince: now,
    });
    return result({
      ...item.artifact,
      state: 'pending',
      reason: 'orphan-candidate-marked',
      firstObservedAt: now,
      eligibleAt: now + this.gracePeriodMs,
    }, 'marked');
  }

  private async clear(
    item: ScannedArtifact,
    current: SessionOwnershipRecord,
    now: number,
  ): Promise<CleanupArtifactResult> {
    if (current.state !== 'orphan-candidate' || !await this.isProtected(current.conversationId)) {
      return result(item.artifact, 'skipped');
    }
    writeSessionOwnershipRecord(item.root!.config, {
      ...current,
      state: 'active',
      stateSince: now,
    });
    return result({ ...item.artifact, state: 'untracked', reason: 'ownership-restored' }, 'cleared');
  }

  private async delete(
    item: ScannedArtifact,
    current: SessionOwnershipRecord,
    now: number,
  ): Promise<CleanupArtifactResult> {
    if (current.state === 'orphan-candidate') {
      if (await this.isProtected(current.conversationId)
        || now < current.stateSince + this.gracePeriodMs) {
        return result(item.artifact, 'skipped');
      }
      const markedArtifactId = markSessionStorageDeletePending(
        item.root!.config,
        current.conversationId,
        this.ownerId,
        now,
      );
      if (markedArtifactId !== current.artifactId) return result(item.artifact, 'skipped');
    } else if (current.state !== 'delete-pending') {
      return result(item.artifact, 'skipped');
    }

    // Re-read after the state transition and immediately before quarantine.
    const finalRecord = readSessionOwnershipRecord(item.root!.config, current.conversationId);
    if (!finalRecord
      || finalRecord.artifactId !== current.artifactId
      || finalRecord.ownerId !== this.ownerId
      || finalRecord.state !== 'delete-pending') {
      return result(item.artifact, 'skipped');
    }
    await deleteManagedSessionStorage(
      item.root!.config,
      current.conversationId,
      this.ownerId,
      current.artifactId,
    );
    return result(item.artifact, 'deleted');
  }
}

function deduplicateRoots(roots: LocalPersistentDataRoot[]): RootContext[] {
  const grouped = new Map<string, { config: SessionStorageConfig; runtimeIds: Set<string> }>();
  for (const entry of roots) {
    const rootKey = resolve(process.cwd(), entry.config.sharedRoot);
    const existing = grouped.get(rootKey);
    if (existing) {
      existing.runtimeIds.add(entry.runtimeId);
    } else {
      grouped.set(rootKey, { config: entry.config, runtimeIds: new Set([entry.runtimeId]) });
    }
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rootKey, entry]) => ({
      rootKey,
      config: entry.config,
      runtimeId: entry.runtimeIds.size === 1 ? [...entry.runtimeIds][0] : undefined,
    }));
}

function conversationArtifact(
  root: RootContext,
  conversationId: string,
  artifactId: string,
  fields: Omit<CleanupArtifact, 'target' | 'backend' | 'runtimeId' | 'conversationId' | 'artifactId'>,
  action: LocalAction,
  record?: SessionOwnershipRecord,
  errorMessage?: string,
): ScannedArtifact {
  return {
    artifact: {
      target: 'persistentData',
      backend: 'filesystem',
      artifactId,
      ...(root.runtimeId ? { runtimeId: root.runtimeId } : {}),
      conversationId,
      ...fields,
    },
    action,
    root,
    ...(record ? { record } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function opaqueArtifact(
  root: RootContext,
  reason: string,
  action: LocalAction,
  discriminator = reason,
): ScannedArtifact {
  return {
    artifact: {
      target: 'persistentData',
      backend: 'filesystem',
      artifactId: opaqueId('unsafe', root.rootKey, discriminator),
      ...(root.runtimeId ? { runtimeId: root.runtimeId } : {}),
      state: 'untracked',
      reason,
      sizeBytes: null,
    },
    action,
    ...(action === 'error' ? { errorMessage: 'Persistent session storage is unsafe to inspect' } : {}),
  };
}

function result(
  artifact: CleanupArtifact,
  outcome: CleanupArtifactResult['outcome'],
  code?: string,
  message?: string,
): CleanupArtifactResult {
  return {
    ...artifact,
    outcome,
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

function opaqueId(kind: string, root: string, value: string): string {
  return `${kind}-${createHash('sha256').update(root).update('\0').update(value).digest('hex').slice(0, 20)}`;
}

function isPlainDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isPlainFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function safeModifiedAt(path: string): number | undefined {
  try {
    return Math.trunc(lstatSync(path).mtimeMs);
  } catch {
    return undefined;
  }
}

function safeDirectorySize(path: string): number | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    let total = 0;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) return null;
      if (entry.isDirectory()) {
        const nested = safeDirectorySize(child);
        if (nested === null) return null;
        total += nested;
      } else if (entry.isFile()) {
        total += lstatSync(child).size;
      } else {
        return null;
      }
    }
    return total;
  } catch {
    return null;
  }
}
