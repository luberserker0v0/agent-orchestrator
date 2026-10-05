import {
  CLEANUP_ARTIFACT_ANNOTATION,
  CLEANUP_OWNER_ANNOTATION,
  CLEANUP_STATE_ANNOTATION,
  CLEANUP_STATE_SINCE_ANNOTATION,
  CONVERSATION_LABEL,
  isPersistentDataArtifactId,
  isManagedPersistentVolumeClaim,
  persistentDataAnnotations,
  type KubernetesPersistentDataApi,
  type PersistentDataCleanupState,
  type PersistentVolumeClaimView,
} from '../agent-runtime/runtimes/kubernetes.js';
import type { StatusObjectsApi } from '../cluster/status-reporter.js';
import type { CleanupArtifact, CleanupArtifactResult, CleanupProvider } from './types.js';
import { ErrorCodes } from '../utils/errors.js';
import { isValidConversationId } from '../utils/conversation-id.js';

const GROUP = 'agentorchestrator.io';
const VERSION = 'v1alpha1';
const INSTANCES_PLURAL = 'opencodeinstances';
const ROUTES_PLURAL = 'conversationroutes';

interface ObjectReferences {
  names: Set<string>;
  conversations: Set<string>;
  claims: Set<string>;
}

interface ScannedClaim {
  claim: PersistentVolumeClaimView;
  conversationId?: string;
  protection?: string;
  safeToMutate: boolean;
  state?: PersistentDataCleanupState;
  artifact: CleanupArtifact;
}

export interface KubernetesPersistentDataProviderOptions {
  /** User-facing orphan cleanup switch. */
  orphanCleanupEnabled: boolean;
  /** Retry durable explicit-delete markers independently of orphan reaping. */
  retryPendingDeletes?: boolean;
  /** True only while cluster status reporting has a usable CR client. */
  clusterStatusReportingEnabled: boolean;
  /** Namespace containing managed PVCs and their referencing Pods. */
  namespace: string;
  /** Namespace containing OpencodeInstance and ConversationRoute authority. */
  authorityNamespace?: string;
  ownerId: string;
  gracePeriodMs: number;
  api: KubernetesPersistentDataApi;
  objectsApi: StatusObjectsApi;
  runtimeId?: string;
  hasLiveConversation(conversationId: string): boolean | Promise<boolean>;
  hasLocalWorkspace(conversationId: string): boolean | Promise<boolean>;
  /** Shares the conversation lifecycle mutex with start/restart/delete. */
  withConversationLock?<T>(conversationId: string, operation: () => Promise<T>): Promise<T>;
}

/**
 * Retention-aware Kubernetes PVC reaper. Every mutation is gated by all
 * available ownership authorities and UID-preconditioned Kubernetes writes.
 */
export class KubernetesPersistentDataCleanupProvider implements CleanupProvider {
  readonly target = 'persistentData' as const;
  readonly backend = 'kubernetes' as const;
  readonly enabled: boolean;

  constructor(private readonly options: KubernetesPersistentDataProviderOptions) {
    this.enabled = options.clusterStatusReportingEnabled
      && (options.orphanCleanupEnabled || options.retryPendingDeletes === true);
  }

  async preview(now: number): Promise<CleanupArtifact[]> {
    if (!this.enabled) return [];
    return (await this.scan(now)).map(candidate => candidate.artifact);
  }

  async run(now: number): Promise<CleanupArtifactResult[]> {
    if (!this.enabled) return [];
    const scanned = await this.scan(now);
    const results: CleanupArtifactResult[] = [];
    for (const candidate of scanned) {
      try {
        const operation = () => this.processCandidate(candidate, now);
        results.push(candidate.conversationId && this.options.withConversationLock
          ? await this.options.withConversationLock(candidate.conversationId, operation)
          : await operation());
      } catch {
        results.push({
          ...candidate.artifact,
          outcome: 'failed',
          code: ErrorCodes.CLEANUP_FAILED,
          message: 'Unable to update Kubernetes persistent-data cleanup state',
        });
      }
    }
    return results;
  }

  private async scan(now: number): Promise<ScannedClaim[]> {
    const { api, namespace, objectsApi } = this.options;
    const authorityNamespace = this.options.authorityNamespace ?? namespace;
    // These three list calls form one authority snapshot. Any failure aborts
    // the provider, rather than turning unavailable authority into absence.
    const [claims, instances, routes] = await Promise.all([
      api.listManagedPersistentVolumeClaims(namespace),
      objectsApi.listNamespacedCustomObject(GROUP, VERSION, authorityNamespace, INSTANCES_PLURAL),
      objectsApi.listNamespacedCustomObject(GROUP, VERSION, authorityNamespace, ROUTES_PLURAL),
    ]);
    const instanceRefs = objectReferences(instances);
    const routeRefs = objectReferences(routes);
    const relevantClaims = this.options.orphanCleanupEnabled
      ? claims
      : claims.filter(claim => claim.annotations[CLEANUP_STATE_ANNOTATION] === 'delete-pending');

    return Promise.all(relevantClaims.map(async claim => {
      // A Pod listing is required for every claim, even claims that later fail
      // ownership validation, so a partial Kubernetes view cannot mutate data.
      const podRefs = await api.listPodsReferencingPersistentVolumeClaim(namespace, claim.name);
      return this.classify(claim, instanceRefs, routeRefs, podRefs.length > 0, now);
    }));
  }

  private async classify(
    claim: PersistentVolumeClaimView,
    instanceRefs: ObjectReferences,
    routeRefs: ObjectReferences,
    hasPodReference: boolean,
    now: number,
  ): Promise<ScannedClaim> {
    const conversationId = claim.labels[CONVERSATION_LABEL];
    const owner = claim.annotations[CLEANUP_OWNER_ANNOTATION];
    const artifactId = claim.annotations[CLEANUP_ARTIFACT_ANNOTATION];
    const rawState = claim.annotations[CLEANUP_STATE_ANNOTATION];
    const state = isCleanupState(rawState) ? rawState : undefined;
    const firstObservedAt = parseTimestamp(claim.annotations[CLEANUP_STATE_SINCE_ANNOTATION]);
    const protectedByCluster = conversationId
      ? referenceMatches(instanceRefs, conversationId, claim.name)
        ? 'opencode-instance-present'
        : referenceMatches(routeRefs, conversationId, claim.name)
          ? 'conversation-route-present'
          : hasPodReference
            ? 'pod-reference-present'
            : undefined
      : undefined;
    const live = state !== 'delete-pending' && conversationId && isValidConversationId(conversationId)
      ? await this.options.hasLiveConversation(conversationId)
      : false;
    const workspace = state !== 'delete-pending' && conversationId && isValidConversationId(conversationId)
      ? await this.options.hasLocalWorkspace(conversationId)
      : false;
    // A durable explicit-delete marker is authoritative. Stale CRs, routes,
    // workspaces, or in-memory state left by an interrupted DELETE must not
    // permanently block its retry; only a Pod that still mounts the claim can.
    const protection = state === 'delete-pending'
      ? (hasPodReference ? 'pod-reference-present' : undefined)
      : protectedByCluster
        ?? (live ? 'live-conversation-present' : undefined)
        ?? (workspace ? 'local-workspace-present' : undefined);

    let safeToMutate = true;
    let reason: string;
    let artifactState: CleanupArtifact['state'];
    if (
      !conversationId
      || !isValidConversationId(conversationId)
      || !isManagedPersistentVolumeClaim(claim, conversationId)
    ) {
      safeToMutate = false;
      reason = 'invalid-managed-metadata';
      artifactState = 'untracked';
    } else if (claim.deletionTimestamp) {
      safeToMutate = false;
      reason = 'deletion-already-in-progress';
      artifactState = 'pending';
    } else if (owner !== this.options.ownerId) {
      safeToMutate = false;
      reason = owner ? 'foreign-owner' : 'missing-owner';
      artifactState = 'untracked';
    } else if (!claim.uid || !isPersistentDataArtifactId(artifactId) || !state || firstObservedAt === undefined) {
      safeToMutate = false;
      reason = 'incomplete-cleanup-metadata';
      artifactState = 'untracked';
    } else if (!this.options.orphanCleanupEnabled && state !== 'delete-pending') {
      reason = 'orphan-cleanup-disabled';
      artifactState = state === 'orphan-candidate' ? 'pending' : 'untracked';
    } else if (protection) {
      reason = protection;
      artifactState = 'untracked';
    } else if (state === 'delete-pending') {
      reason = 'explicit-delete-pending';
      artifactState = 'eligible';
    } else if (state === 'active') {
      reason = 'first-observation-required';
      artifactState = 'pending';
    } else if (now - firstObservedAt >= this.options.gracePeriodMs) {
      reason = 'orphan-retention-expired';
      artifactState = 'eligible';
    } else {
      reason = 'orphan-grace-period';
      artifactState = 'pending';
    }

    return {
      claim,
      ...(conversationId ? { conversationId } : {}),
      ...(protection ? { protection } : {}),
      safeToMutate,
      ...(state ? { state } : {}),
      artifact: {
        target: this.target,
        artifactId: artifactId ?? claim.name,
        backend: 'kubernetes',
        ...(this.options.runtimeId ? { runtimeId: this.options.runtimeId } : {}),
        ...(conversationId && isValidConversationId(conversationId) ? { conversationId } : {}),
        state: artifactState,
        reason,
        sizeBytes: null,
        ...(firstObservedAt !== undefined ? { firstObservedAt } : {}),
        ...(state === 'orphan-candidate' && firstObservedAt !== undefined
          ? { eligibleAt: firstObservedAt + this.options.gracePeriodMs }
          : {}),
      },
    };
  }

  private async processCandidate(candidate: ScannedClaim, now: number): Promise<CleanupArtifactResult> {
    const { claim, state, protection, safeToMutate } = candidate;
    if (!safeToMutate) return { ...candidate.artifact, outcome: 'skipped' };
    if (!this.options.orphanCleanupEnabled && state !== 'delete-pending') {
      return { ...candidate.artifact, outcome: 'skipped' };
    }

    if (protection) {
      if (state !== 'orphan-candidate') return { ...candidate.artifact, outcome: 'skipped' };
      const cleared = await this.patchState(claim, 'active', now);
      return {
        ...candidate.artifact,
        state: 'untracked',
        reason: protection,
        outcome: 'cleared',
        ...(parseTimestamp(cleared.annotations[CLEANUP_STATE_SINCE_ANNOTATION]) !== undefined
          ? { lastModifiedAt: parseTimestamp(cleared.annotations[CLEANUP_STATE_SINCE_ANNOTATION]) }
          : {}),
      };
    }

    if (state === 'active') {
      await this.patchState(claim, 'orphan-candidate', now);
      return {
        ...candidate.artifact,
        state: 'pending',
        reason: 'orphan-first-observed',
        firstObservedAt: now,
        eligibleAt: now + this.options.gracePeriodMs,
        outcome: 'marked',
      };
    }

    if (candidate.artifact.state !== 'eligible') {
      return { ...candidate.artifact, outcome: 'skipped' };
    }
    return this.deleteAfterFinalCheck(candidate, now);
  }

  private async patchState(
    claim: PersistentVolumeClaimView,
    state: PersistentDataCleanupState,
    now: number,
  ): Promise<PersistentVolumeClaimView> {
    if (!claim.uid || !claim.resourceVersion) {
      throw new Error(`Persistent volume claim ${claim.name} lacks mutation preconditions`);
    }
    return this.options.api.patchPersistentVolumeClaimAnnotations(
      this.options.namespace,
      claim.name,
      claim.uid,
      claim.resourceVersion,
      {
        ...claim.annotations,
        ...persistentDataAnnotations(
          this.options.ownerId,
          state,
          new Date(now).toISOString(),
          claim.annotations[CLEANUP_ARTIFACT_ANNOTATION],
        ),
      },
    );
  }

  private async deleteAfterFinalCheck(
    candidate: ScannedClaim,
    now: number,
  ): Promise<CleanupArtifactResult> {
    const { api, namespace } = this.options;
    const expected = candidate.claim;
    const current = await api.readPersistentVolumeClaim(namespace, expected.name);
    if (
      current.uid !== expected.uid
      || current.deletionTimestamp !== expected.deletionTimestamp
      || !candidate.conversationId
      || !isManagedPersistentVolumeClaim(current, candidate.conversationId)
      || current.annotations[CLEANUP_OWNER_ANNOTATION] !== this.options.ownerId
      || current.annotations[CLEANUP_ARTIFACT_ANNOTATION] !== expected.annotations[CLEANUP_ARTIFACT_ANNOTATION]
      || current.annotations[CLEANUP_STATE_ANNOTATION] !== expected.annotations[CLEANUP_STATE_ANNOTATION]
      || current.annotations[CLEANUP_STATE_SINCE_ANNOTATION] !== expected.annotations[CLEANUP_STATE_SINCE_ANNOTATION]
    ) {
      return {
        ...candidate.artifact,
        outcome: 'skipped',
        code: 'KUBERNETES_OBJECT_CHANGED',
        message: 'Persistent data changed during cleanup; retry on a later sweep',
      };
    }

    const protection = candidate.state === 'delete-pending'
      ? (await api.listPodsReferencingPersistentVolumeClaim(namespace, current.name)).length > 0
        ? 'pod-reference-present'
        : undefined
      : await this.currentProtection(candidate.conversationId!, current.name);
    if (protection) {
      if (candidate.state === 'orphan-candidate') {
        await this.patchState(current, 'active', now);
        return { ...candidate.artifact, state: 'untracked', reason: protection, outcome: 'cleared' };
      }
      return { ...candidate.artifact, state: 'untracked', reason: protection, outcome: 'skipped' };
    }

    await api.deletePersistentVolumeClaim(namespace, current.name, current.uid);
    return { ...candidate.artifact, outcome: 'deleted' };
  }

  private async currentProtection(conversationId: string, claimName: string): Promise<string | undefined> {
    const { api, namespace, objectsApi } = this.options;
    const authorityNamespace = this.options.authorityNamespace ?? namespace;
    const [instances, routes, pods, live, workspace] = await Promise.all([
      objectsApi.listNamespacedCustomObject(GROUP, VERSION, authorityNamespace, INSTANCES_PLURAL),
      objectsApi.listNamespacedCustomObject(GROUP, VERSION, authorityNamespace, ROUTES_PLURAL),
      api.listPodsReferencingPersistentVolumeClaim(namespace, claimName),
      this.options.hasLiveConversation(conversationId),
      this.options.hasLocalWorkspace(conversationId),
    ]);
    if (referenceMatches(objectReferences(instances), conversationId, claimName)) return 'opencode-instance-present';
    if (referenceMatches(objectReferences(routes), conversationId, claimName)) return 'conversation-route-present';
    if (pods.length > 0) return 'pod-reference-present';
    if (live) return 'live-conversation-present';
    if (workspace) return 'local-workspace-present';
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function objectReferences(list: { body: object }): ObjectReferences {
  const body = asRecord(list.body);
  const items = Array.isArray(body.items) ? body.items : [];
  const references: ObjectReferences = { names: new Set(), conversations: new Set(), claims: new Set() };
  for (const item of items) {
    const record = asRecord(item);
    const metadata = asRecord(record.metadata);
    const spec = asRecord(record.spec);
    if (typeof metadata.name === 'string') references.names.add(metadata.name);
    if (typeof spec.conversationId === 'string') references.conversations.add(spec.conversationId);
    if (typeof spec.volumeClaimName === 'string') references.claims.add(spec.volumeClaimName);
  }
  return references;
}

function referenceMatches(references: ObjectReferences, conversationId: string, claimName: string): boolean {
  return references.names.has(conversationId)
    || references.conversations.has(conversationId)
    || references.claims.has(claimName);
}

function isCleanupState(value: string | undefined): value is PersistentDataCleanupState {
  return value === 'active' || value === 'delete-pending' || value === 'orphan-candidate';
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
