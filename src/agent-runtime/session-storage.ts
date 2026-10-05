import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { logger } from '../utils/logger.js';
import { AppError, ErrorCodes } from '../utils/errors.js';
import { isValidConversationId } from '../utils/conversation-id.js';
import type { SessionStorageConfig } from '../config-loader.js';

export interface ResolvedSessionStorage {
  /** Absolute per-conversation data-dir: `<sharedRoot>/<sanitized id>` */
  sessionDir: string;
  /** Env vars to inject into the opencode server process */
  env: Record<string, string>;
  /** Immutable generation identifier used by cleanup tombstones. */
  artifactId?: string;
}

export const SESSION_STORAGE_RECORD_VERSION = 1 as const;
export const SESSION_STORAGE_CONTROL_DIR = '.agentorchestrator';
/** Internal owner for explicit-delete tombstones when cleanup.ownerId is null. */
export const DEFAULT_SESSION_CLEANUP_OWNER = 'agent-orchestrator';

export type SessionOwnershipState = 'active' | 'delete-pending' | 'orphan-candidate';

export interface SessionOwnershipRecord {
  version: typeof SESSION_STORAGE_RECORD_VERSION;
  artifactId: string;
  conversationId: string;
  ownerId: string;
  state: SessionOwnershipState;
  stateSince: number;
}

export interface SessionStorageLayout {
  root: string;
  controlDir: string;
  recordsDir: string;
  quarantineDir: string;
}

const RECORD_FILE_SUFFIX = '.json';
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNERSHIP_STATES = new Set<SessionOwnershipState>(['active', 'delete-pending', 'orphan-candidate']);

/**
 * Sanitize a conversation id for use as a single path segment.
 * Mirrors WorkspaceFactory.sanitizeId so both sides agree on the layout.
 * Runtime API calls use canonical IDs; this remains exported for legacy
 * storage discovery and backwards-compatible callers.
 */
export function sanitizeSessionId(id: string): string {
  return id.replace(/[\\/]/g, '_').replace(/\.{2,}/g, '_');
}

/** Resolve the cleanup control directories without creating them. */
export function resolveSessionStorageLayout(config: SessionStorageConfig): SessionStorageLayout {
  const root = resolve(process.cwd(), config.sharedRoot);
  if (root === parse(root).root) {
    throw new Error('Session storage sharedRoot cannot be a filesystem root');
  }
  const controlDir = join(root, SESSION_STORAGE_CONTROL_DIR);
  return {
    root,
    controlDir,
    recordsDir: join(controlDir, 'records'),
    quarantineDir: join(controlDir, 'quarantine'),
  };
}

/** Return the canonical ownership-record path for a conversation. */
export function sessionOwnershipRecordPath(config: SessionStorageConfig, id: string): string {
  assertCanonicalConversationId(id);
  const layout = resolveSessionStorageLayout(config);
  return checkedChild(layout.recordsDir, `${id}${RECORD_FILE_SUFFIX}`);
}

/** Return the generation-specific quarantine path. */
export function sessionQuarantinePath(config: SessionStorageConfig, artifactId: string): string {
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) {
    throw new Error('Invalid session artifact id');
  }
  const layout = resolveSessionStorageLayout(config);
  return checkedChild(layout.quarantineDir, artifactId);
}

/** List record filenames for cleanup discovery; malformed entries remain visible to the caller. */
export function listSessionOwnershipRecordFiles(config: SessionStorageConfig): string[] {
  const { recordsDir } = resolveSessionStorageLayout(config);
  if (!existsSync(recordsDir)) return [];
  assertPlainDirectory(recordsDir, 'session ownership records directory');
  return readdirSync(recordsDir).sort();
}

/** Read and validate a canonical conversation's ownership record. */
export function readSessionOwnershipRecord(
  config: SessionStorageConfig,
  id: string,
): SessionOwnershipRecord | undefined {
  const recordPath = sessionOwnershipRecordPath(config, id);
  if (!existsSync(recordPath)) return undefined;
  assertPlainFile(recordPath, 'session ownership record');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch (err) {
    throw new Error(`Session ownership record for ${id} is not valid JSON`, { cause: err });
  }
  return validateOwnershipRecord(parsed, id);
}

/**
 * Persist a record via a same-directory temporary file. The artifact ID may
 * not change when updating an existing generation.
 */
export function writeSessionOwnershipRecord(
  config: SessionStorageConfig,
  record: SessionOwnershipRecord,
): void {
  validateOwnershipRecord(record, record.conversationId);
  const layout = ensureControlDirectories(config);
  const recordPath = sessionOwnershipRecordPath(config, record.conversationId);
  const existing = readSessionOwnershipRecord(config, record.conversationId);
  if (existing && existing.artifactId !== record.artifactId) {
    throw new Error(`Session artifact id for ${record.conversationId} is immutable`);
  }
  const tempPath = checkedChild(layout.recordsDir, `.${record.conversationId}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tempPath, recordPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

/** Create a new ownership generation for an existing unmarked canonical directory. */
export function createSessionOwnershipRecord(
  id: string,
  ownerId = DEFAULT_SESSION_CLEANUP_OWNER,
  state: SessionOwnershipState = 'active',
  now = Date.now(),
): SessionOwnershipRecord {
  return { ...newOwnershipRecord(id, ownerId, now), state };
}

/**
 * Mark a managed conversation generation delete-pending. This is safe to call
 * before the process/container is stopped and idempotent across retries.
 */
export function markSessionStorageDeletePending(
  config: SessionStorageConfig,
  id: string,
  ownerId = DEFAULT_SESSION_CLEANUP_OWNER,
  now = Date.now(),
): string | undefined {
  assertCanonicalConversationId(id);
  const layout = ensureControlDirectories(config);
  const sessionDir = checkedChild(layout.root, id);
  let record = readSessionOwnershipRecord(config, id);

  if (!record && !existsSync(sessionDir)) return undefined;
  if (!record) {
    assertPlainDirectory(sessionDir, 'session data directory');
    record = newOwnershipRecord(id, ownerId, now);
  }
  assertOwner(record, ownerId);
  if (record.state !== 'delete-pending') {
    record = { ...record, state: 'delete-pending', stateSince: now };
    writeSessionOwnershipRecord(config, record);
  }
  return record.artifactId;
}

/**
 * Atomically detach a delete-pending generation from its canonical path. A
 * stale expectedArtifactId can only purge its own quarantine generation and
 * never a newly-created session with the same conversation id.
 */
export function quarantineSessionStorage(
  config: SessionStorageConfig,
  id: string,
  ownerId = DEFAULT_SESSION_CLEANUP_OWNER,
  expectedArtifactId?: string,
): { artifactId: string; quarantineDir: string } | undefined {
  assertCanonicalConversationId(id);
  const layout = ensureControlDirectories(config);
  const record = readSessionOwnershipRecord(config, id);

  if (expectedArtifactId && record?.artifactId !== expectedArtifactId) {
    const staleQuarantine = sessionQuarantinePath(config, expectedArtifactId);
    return existsSync(staleQuarantine)
      ? { artifactId: expectedArtifactId, quarantineDir: staleQuarantine }
      : undefined;
  }
  if (!record) return undefined;
  assertOwner(record, ownerId);
  if (record.state !== 'delete-pending') {
    throw cleanupPendingError(id, 'persistent data is not marked delete-pending');
  }

  const sessionDir = checkedChild(layout.root, id);
  const quarantineDir = sessionQuarantinePath(config, record.artifactId);
  if (existsSync(quarantineDir)) {
    assertPlainDirectory(quarantineDir, 'session quarantine directory');
    if (existsSync(sessionDir)) {
      throw cleanupPendingError(id, 'both active and quarantined generations exist');
    }
    return { artifactId: record.artifactId, quarantineDir };
  }
  if (!existsSync(sessionDir)) return undefined;
  assertPlainDirectory(sessionDir, 'session data directory');
  renameSync(sessionDir, quarantineDir);
  return { artifactId: record.artifactId, quarantineDir };
}

/**
 * Purge a managed generation. On failure its delete-pending record and
 * quarantine directory remain intact so a later explicit/scheduled retry can
 * finish cleanup.
 */
export async function deleteManagedSessionStorage(
  config: SessionStorageConfig,
  id: string,
  ownerId = DEFAULT_SESSION_CLEANUP_OWNER,
  expectedArtifactId?: string,
): Promise<void> {
  const artifactId = expectedArtifactId
    ?? markSessionStorageDeletePending(config, id, ownerId);
  if (!artifactId) return;

  const quarantined = quarantineSessionStorage(config, id, ownerId, artifactId);
  const quarantineDir = quarantined?.quarantineDir ?? sessionQuarantinePath(config, artifactId);
  try {
    if (existsSync(quarantineDir)) {
      assertPlainDirectory(quarantineDir, 'session quarantine directory');
      rmSync(quarantineDir, { recursive: true, force: true });
    }
  } catch (err) {
    throw cleanupPendingError(id, 'quarantined data could not be purged', err);
  }

  const current = readSessionOwnershipRecord(config, id);
  if (current?.artifactId === artifactId && current.state === 'delete-pending') {
    rmSync(sessionOwnershipRecordPath(config, id), { force: true });
  }
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
  ownerId?: string,
): ResolvedSessionStorage {
  const mode = config.mode ?? 'xdg';
  const layout = resolveSessionStorageLayout(config);
  const canonical = isValidConversationId(id);
  const segment = canonical ? id : sanitizeSessionId(id);
  const sessionDir = checkedChild(layout.root, segment);
  let artifactId: string | undefined;
  try {
    ensureRootDirectory(layout.root);
    if (existsSync(sessionDir)) assertPlainDirectory(sessionDir, 'session data directory');

    // Ownership records are intentionally limited to canonical public IDs.
    // Legacy internal callers keep their prior sanitized layout without being
    // made eligible for automated cleanup.
    if (canonical) {
      let record = readSessionOwnershipRecord(config, id);
      if (record?.state === 'delete-pending') {
        throw cleanupPendingError(id, 'a previous cleanup has not completed');
      }

      // A null cleanup.ownerId must leave ordinary session directories
      // unmarked. This lets a later, explicitly configured owner enroll
      // pre-existing data through the first-observed grace-period workflow.
      // Explicit deletion still creates a short-lived default-owner tombstone
      // via markSessionStorageDeletePending().
      if (ownerId !== undefined) {
        ensureControlDirectories(config);
        if (record) {
          assertOwner(record, ownerId);
          artifactId = record.artifactId;
          if (record.state !== 'active') {
            record = { ...record, state: 'active', stateSince: Date.now() };
            writeSessionOwnershipRecord(config, record);
          }
        } else {
          const newRecord = newOwnershipRecord(id, ownerId, Date.now());
          artifactId = newRecord.artifactId;
          writeSessionOwnershipRecord(config, newRecord);
        }
      }
    }

    mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new Error(
      `Failed to prepare session storage for ${id}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const env: Record<string, string> = { XDG_DATA_HOME: sessionDir };
  if (mode === 'sqlite') {
    env.OPENCODE_DB = join(sessionDir, 'opencode.db');
  }
  logger.debug(`Session storage prepared for ${id} (mode: ${mode})`);
  return { sessionDir, env, ...(artifactId ? { artifactId } : {}) };
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

/**
 * Canonical in-cluster mount root for a conversation volume. Must be identical
 * on every machine (opencode project hash and session rows key on it).
 */
export function conversationMountPath(id: string): string {
  return `/data/conversations/${sanitizeSessionId(id)}`;
}

/**
 * Session env vars for instance Pods mounting the per-conversation PVC at
 * {@link conversationMountPath}. The data itself lives on the PVC; only the
 * mode selects the env mapping.
 */
export function sessionPodEnv(id: string, mode: 'xdg' | 'sqlite' = 'xdg'): Record<string, string> {
  const base = `${conversationMountPath(id)}/session`;
  const env: Record<string, string> = { XDG_DATA_HOME: base };
  if (mode === 'sqlite') {
    env.OPENCODE_DB = `${base}/opencode.db`;
  }
  return env;
}

function ensureRootDirectory(root: string): void {
  if (existsSync(root)) {
    assertPlainDirectory(root, 'session storage root');
    return;
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPlainDirectory(root, 'session storage root');
}

function ensureControlDirectories(config: SessionStorageConfig): SessionStorageLayout {
  const layout = resolveSessionStorageLayout(config);
  ensureRootDirectory(layout.root);
  for (const dir of [layout.controlDir, layout.recordsDir, layout.quarantineDir]) {
    if (existsSync(dir)) {
      assertPlainDirectory(dir, 'session cleanup control directory');
    } else {
      mkdirSync(dir, { mode: 0o700 });
    }
  }
  return layout;
}

function newOwnershipRecord(id: string, ownerId: string, now: number): SessionOwnershipRecord {
  assertCanonicalConversationId(id);
  const normalizedOwner = normalizeOwnerId(ownerId);
  return {
    version: SESSION_STORAGE_RECORD_VERSION,
    artifactId: randomUUID(),
    conversationId: id,
    ownerId: normalizedOwner,
    state: 'active',
    stateSince: now,
  };
}

function validateOwnershipRecord(value: unknown, expectedId: string): SessionOwnershipRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Session ownership record for ${expectedId} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== SESSION_STORAGE_RECORD_VERSION
    || typeof record.artifactId !== 'string'
    || !ARTIFACT_ID_PATTERN.test(record.artifactId)
    || record.conversationId !== expectedId
    || !isValidConversationId(expectedId)
    || typeof record.ownerId !== 'string'
    || !record.ownerId.trim()
    || typeof record.state !== 'string'
    || !OWNERSHIP_STATES.has(record.state as SessionOwnershipState)
    || typeof record.stateSince !== 'number'
    || !Number.isSafeInteger(record.stateSince)
    || record.stateSince < 0
  ) {
    throw new Error(`Session ownership record for ${expectedId} is invalid`);
  }
  return record as unknown as SessionOwnershipRecord;
}

function normalizeOwnerId(ownerId: string): string {
  const normalized = ownerId.trim();
  if (!normalized) throw new Error('Session cleanup owner must be non-empty');
  return normalized;
}

function assertOwner(record: SessionOwnershipRecord, ownerId: string): void {
  if (record.ownerId !== normalizeOwnerId(ownerId)) {
    throw new Error(`Session data for ${record.conversationId} is owned by another orchestrator`);
  }
}

function assertCanonicalConversationId(id: string): void {
  if (!isValidConversationId(id)) {
    throw new Error('Session cleanup requires a canonical conversation id');
  }
}

function checkedChild(parent: string, name: string): string {
  const candidate = resolve(parent, name);
  const rel = relative(parent, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Unsafe session storage path segment: ${basename(name)}`);
  }
  return candidate;
}

function assertPlainDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe ${label}`);
  }
}

function assertPlainFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Unsafe ${label}`);
  }
}

function cleanupPendingError(id: string, reason: string, cause?: unknown): AppError {
  return new AppError(
    409,
    ErrorCodes.PERSISTENT_DATA_CLEANUP_PENDING,
    `Persistent data cleanup is pending for ${id}: ${reason}`,
    cause,
  );
}
