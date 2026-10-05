import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLEANUP_ARTIFACT_ANNOTATION,
  CLEANUP_OWNER_ANNOTATION,
  CLEANUP_STATE_ANNOTATION,
  CLEANUP_STATE_SINCE_ANNOTATION,
  CONVERSATION_LABEL,
  PART_OF_LABEL,
  PART_OF_VALUE,
  type KubernetesPersistentDataApi,
  type PersistentVolumeClaimView,
} from '../agent-runtime/runtimes/kubernetes.js';
import type { StatusObjectsApi } from '../cluster/status-reporter.js';
import { KubernetesPersistentDataCleanupProvider } from './kubernetes-persistent-data-provider.js';

const OWNER = 'owner-a';
const ARTIFACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = Date.parse('2026-10-04T00:00:00.000Z');
const GRACE = 30 * 24 * 60 * 60 * 1000;

function claim(
  state: 'active' | 'delete-pending' | 'orphan-candidate' = 'active',
  stateSince = new Date(NOW).toISOString(),
  overrides: Partial<PersistentVolumeClaimView> = {},
): PersistentVolumeClaimView {
  return {
    name: 'conv-a',
    uid: 'uid-a',
    resourceVersion: '1',
    labels: { [PART_OF_LABEL]: PART_OF_VALUE, [CONVERSATION_LABEL]: 'a' },
    annotations: {
      [CLEANUP_OWNER_ANNOTATION]: OWNER,
      [CLEANUP_ARTIFACT_ANNOTATION]: ARTIFACT,
      [CLEANUP_STATE_ANNOTATION]: state,
      [CLEANUP_STATE_SINCE_ANNOTATION]: stateSince,
    },
    ...overrides,
  };
}

function objectList(items: object[] = []): { body: object } {
  return { body: { items } };
}

function createHarness(initial = claim()) {
  let current: PersistentVolumeClaimView | undefined = structuredClone(initial);
  let instances: object[] = [];
  let routes: object[] = [];
  let pods: Array<{ name: string }> = [];
  const api: KubernetesPersistentDataApi = {
    readPersistentVolumeClaim: vi.fn(async () => {
      if (!current) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return structuredClone(current);
    }),
    listManagedPersistentVolumeClaims: vi.fn(async () => current ? [structuredClone(current)] : []),
    patchPersistentVolumeClaimAnnotations: vi.fn(async (
      _namespace,
      _name,
      expectedUid,
      expectedResourceVersion,
      annotations,
    ) => {
      if (!current || current.uid !== expectedUid) throw new Error('uid changed');
      if (current.resourceVersion !== expectedResourceVersion) throw new Error('resource version changed');
      current = {
        ...current,
        resourceVersion: String(Number(current.resourceVersion ?? 0) + 1),
        annotations: { ...annotations },
      };
      return structuredClone(current);
    }),
    deletePersistentVolumeClaim: vi.fn(async (_namespace, _name, expectedUid) => {
      if (!current || current.uid !== expectedUid) throw new Error('uid changed');
      current = undefined;
    }),
    listPodsReferencingPersistentVolumeClaim: vi.fn(async () => [...pods]),
  };
  const objectsApi = {
    listNamespacedCustomObject: vi.fn(async (_group: string, _version: string, _namespace: string, plural: string) =>
      objectList(plural === 'opencodeinstances' ? instances : routes)),
  } as unknown as StatusObjectsApi;
  let live = false;
  let workspace = false;
  const provider = new KubernetesPersistentDataCleanupProvider({
    orphanCleanupEnabled: true,
    clusterStatusReportingEnabled: true,
    namespace: 'ao-instances',
    ownerId: OWNER,
    gracePeriodMs: GRACE,
    api,
    objectsApi,
    runtimeId: 'opencode-k8s',
    hasLiveConversation: vi.fn(async () => live),
    hasLocalWorkspace: vi.fn(async () => workspace),
  });
  return {
    provider,
    api,
    objectsApi,
    current: () => current,
    setCurrent: (value: PersistentVolumeClaimView | undefined) => { current = value; },
    setInstances: (value: object[]) => { instances = value; },
    setRoutes: (value: object[]) => { routes = value; },
    setPods: (value: Array<{ name: string }>) => { pods = value; },
    setLive: (value: boolean) => { live = value; },
    setWorkspace: (value: boolean) => { workspace = value; },
  };
}

describe('KubernetesPersistentDataCleanupProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is disabled unless both orphan cleanup and status reporting are enabled', async () => {
    const harness = createHarness();
    const provider = new KubernetesPersistentDataCleanupProvider({
      orphanCleanupEnabled: true,
      clusterStatusReportingEnabled: false,
      namespace: 'ao-instances',
      ownerId: OWNER,
      gracePeriodMs: GRACE,
      api: harness.api,
      objectsApi: harness.objectsApi,
      hasLiveConversation: () => false,
      hasLocalWorkspace: () => false,
    });

    expect(provider.enabled).toBe(false);
    expect(await provider.preview(NOW)).toEqual([]);
    expect(harness.api.listManagedPersistentVolumeClaims).not.toHaveBeenCalled();
  });

  it('reads PVCs and ownership authority from their configured namespaces', async () => {
    const harness = createHarness();
    const provider = new KubernetesPersistentDataCleanupProvider({
      orphanCleanupEnabled: true,
      clusterStatusReportingEnabled: true,
      namespace: 'runtime-pvc-namespace',
      authorityNamespace: 'cluster-authority-namespace',
      ownerId: OWNER,
      gracePeriodMs: GRACE,
      api: harness.api,
      objectsApi: harness.objectsApi,
      hasLiveConversation: () => false,
      hasLocalWorkspace: () => false,
    });

    await provider.preview(NOW);

    expect(harness.api.listManagedPersistentVolumeClaims)
      .toHaveBeenCalledWith('runtime-pvc-namespace');
    expect(harness.objectsApi.listNamespacedCustomObject)
      .toHaveBeenCalledWith('agentorchestrator.io', 'v1alpha1', 'cluster-authority-namespace', 'opencodeinstances');
    expect(harness.objectsApi.listNamespacedCustomObject)
      .toHaveBeenCalledWith('agentorchestrator.io', 'v1alpha1', 'cluster-authority-namespace', 'conversationroutes');
  });

  it('fails closed when any authority listing is unavailable', async () => {
    const harness = createHarness();
    vi.mocked(harness.objectsApi.listNamespacedCustomObject).mockRejectedValueOnce(new Error('CR API down'));

    await expect(harness.provider.run(NOW)).rejects.toThrow('CR API down');
    expect(harness.api.patchPersistentVolumeClaimAnnotations).not.toHaveBeenCalled();
    expect(harness.api.deletePersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it.each([
    ['OpencodeInstance', (h: ReturnType<typeof createHarness>) => h.setInstances([{ metadata: { name: 'a' } }]), 'opencode-instance-present'],
    ['ConversationRoute', (h: ReturnType<typeof createHarness>) => h.setRoutes([{ spec: { conversationId: 'a' } }]), 'conversation-route-present'],
    ['Pod', (h: ReturnType<typeof createHarness>) => h.setPods([{ name: 'reader' }]), 'pod-reference-present'],
    ['live conversation', (h: ReturnType<typeof createHarness>) => h.setLive(true), 'live-conversation-present'],
    ['local workspace', (h: ReturnType<typeof createHarness>) => h.setWorkspace(true), 'local-workspace-present'],
  ])('protects an orphan-candidate when a matching %s exists', async (_label, arrange, reason) => {
    const old = new Date(NOW - GRACE - 1).toISOString();
    const harness = createHarness(claim('orphan-candidate', old));
    arrange(harness);

    const result = await harness.provider.run(NOW);

    expect(result).toEqual([expect.objectContaining({ outcome: 'cleared', reason })]);
    expect(harness.current()?.annotations[CLEANUP_STATE_ANNOTATION]).toBe('active');
    expect(harness.api.deletePersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it('records the first orphan observation without deleting', async () => {
    const harness = createHarness(claim('active', new Date(NOW - GRACE * 2).toISOString()));

    const result = await harness.provider.run(NOW);

    expect(result).toEqual([expect.objectContaining({
      outcome: 'marked',
      state: 'pending',
      reason: 'orphan-first-observed',
      firstObservedAt: NOW,
      eligibleAt: NOW + GRACE,
    })]);
    expect(harness.current()?.annotations).toMatchObject({
      [CLEANUP_STATE_ANNOTATION]: 'orphan-candidate',
      [CLEANUP_STATE_SINCE_ANNOTATION]: new Date(NOW).toISOString(),
    });
    expect(harness.api.deletePersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it('waits the full grace period and deletes only on a later observation', async () => {
    const firstObserved = NOW - GRACE - 1;
    const harness = createHarness(claim('orphan-candidate', new Date(firstObserved).toISOString()));

    const preview = await harness.provider.preview(NOW);
    const result = await harness.provider.run(NOW);

    expect(preview).toEqual([expect.objectContaining({
      state: 'eligible', reason: 'orphan-retention-expired', firstObservedAt: firstObserved,
    })]);
    expect(result).toEqual([expect.objectContaining({ outcome: 'deleted' })]);
    expect(harness.api.deletePersistentVolumeClaim).toHaveBeenCalledWith(
      'ao-instances', 'conv-a', 'uid-a',
    );
    expect(harness.current()).toBeUndefined();
  });

  it('rechecks authority immediately before delete and clears the mark if ownership reappears', async () => {
    const harness = createHarness(claim('orphan-candidate', new Date(NOW - GRACE - 1).toISOString()));
    vi.mocked(harness.objectsApi.listNamespacedCustomObject).mockImplementation(
      async (_group, _version, _namespace, plural) => {
        const callsForInstances = vi.mocked(harness.objectsApi.listNamespacedCustomObject).mock.calls
          .filter(call => call[3] === 'opencodeinstances').length;
        if (plural === 'opencodeinstances' && callsForInstances >= 2) {
          return objectList([{ metadata: { name: 'a' } }]);
        }
        return objectList();
      },
    );

    const result = await harness.provider.run(NOW);

    expect(result).toEqual([expect.objectContaining({
      outcome: 'cleared', reason: 'opencode-instance-present',
    })]);
    expect(harness.current()?.annotations[CLEANUP_STATE_ANNOTATION]).toBe('active');
    expect(harness.api.deletePersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it('performs the final authority check under the shared lifecycle lock', async () => {
    const harness = createHarness(claim('orphan-candidate', new Date(NOW - GRACE - 1).toISOString()));
    const lockedIds: string[] = [];
    let live = false;
    const provider = new KubernetesPersistentDataCleanupProvider({
      orphanCleanupEnabled: true,
      clusterStatusReportingEnabled: true,
      namespace: 'ao-instances',
      ownerId: OWNER,
      gracePeriodMs: GRACE,
      api: harness.api,
      objectsApi: harness.objectsApi,
      hasLiveConversation: () => live,
      hasLocalWorkspace: () => false,
      withConversationLock: async <T>(id: string, operation: () => Promise<T>): Promise<T> => {
        lockedIds.push(id);
        live = true;
        return operation();
      },
    });

    const result = await provider.run(NOW);

    expect(lockedIds).toEqual(['a']);
    expect(result).toEqual([expect.objectContaining({
      outcome: 'cleared', reason: 'live-conversation-present',
    })]);
    expect(harness.api.deletePersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it('immediately retries a durable explicit-delete marker once unreferenced', async () => {
    const harness = createHarness(claim('delete-pending'));

    const result = await harness.provider.run(NOW);

    expect(result).toEqual([expect.objectContaining({
      outcome: 'deleted', reason: 'explicit-delete-pending',
    })]);
  });

  it('lets an explicit-delete marker outlive stale authorities but still waits for Pods', async () => {
    const harness = createHarness(claim('delete-pending'));
    harness.setInstances([{ metadata: { name: 'a' } }]);
    harness.setRoutes([{ spec: { conversationId: 'a' } }]);
    harness.setLive(true);
    harness.setWorkspace(true);

    expect(await harness.provider.run(NOW)).toEqual([
      expect.objectContaining({ outcome: 'deleted', reason: 'explicit-delete-pending' }),
    ]);

    const mounted = createHarness(claim('delete-pending'));
    mounted.setInstances([{ metadata: { name: 'a' } }]);
    mounted.setPods([{ name: 'still-mounted' }]);
    expect(await mounted.provider.run(NOW)).toEqual([
      expect.objectContaining({ outcome: 'skipped', reason: 'pod-reference-present' }),
    ]);
    expect(mounted.api.deletePersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it('retries explicit delete markers without enabling Kubernetes orphan reaping', async () => {
    const harness = createHarness(claim('delete-pending'));
    const provider = new KubernetesPersistentDataCleanupProvider({
      orphanCleanupEnabled: false,
      retryPendingDeletes: true,
      clusterStatusReportingEnabled: true,
      namespace: 'ao-instances',
      ownerId: OWNER,
      gracePeriodMs: GRACE,
      api: harness.api,
      objectsApi: harness.objectsApi,
      hasLiveConversation: () => false,
      hasLocalWorkspace: () => false,
    });

    expect(provider.enabled).toBe(true);
    expect(await provider.run(NOW)).toEqual([
      expect.objectContaining({ outcome: 'deleted', reason: 'explicit-delete-pending' }),
    ]);
  });

  it('does not mark ordinary PVCs while only explicit-delete retry is enabled', async () => {
    const harness = createHarness(claim('active'));
    const provider = new KubernetesPersistentDataCleanupProvider({
      orphanCleanupEnabled: false,
      retryPendingDeletes: true,
      clusterStatusReportingEnabled: true,
      namespace: 'ao-instances',
      ownerId: OWNER,
      gracePeriodMs: GRACE,
      api: harness.api,
      objectsApi: harness.objectsApi,
      hasLiveConversation: () => false,
      hasLocalWorkspace: () => false,
    });

    expect(await provider.run(NOW)).toEqual([]);
    expect(harness.api.patchPersistentVolumeClaimAnnotations).not.toHaveBeenCalled();
    expect(harness.api.deletePersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it('never mutates foreign, unlabeled, or incomplete claims', async () => {
    const foreign = createHarness(claim('active', new Date(NOW).toISOString(), {
      annotations: {
        [CLEANUP_OWNER_ANNOTATION]: 'someone-else',
        [CLEANUP_ARTIFACT_ANNOTATION]: ARTIFACT,
        [CLEANUP_STATE_ANNOTATION]: 'active',
        [CLEANUP_STATE_SINCE_ANNOTATION]: new Date(NOW).toISOString(),
      },
    }));
    const unlabeled = createHarness(claim('active', new Date(NOW).toISOString(), {
      annotations: {},
    }));
    const incomplete = createHarness(claim('active', new Date(NOW).toISOString(), {
      annotations: {
        [CLEANUP_OWNER_ANNOTATION]: OWNER,
        [CLEANUP_STATE_ANNOTATION]: 'active',
        [CLEANUP_STATE_SINCE_ANNOTATION]: new Date(NOW).toISOString(),
      },
    }));
    const invalidArtifact = createHarness(claim('active', new Date(NOW).toISOString(), {
      annotations: {
        [CLEANUP_OWNER_ANNOTATION]: OWNER,
        [CLEANUP_ARTIFACT_ANNOTATION]: 'not-a-uuid',
        [CLEANUP_STATE_ANNOTATION]: 'active',
        [CLEANUP_STATE_SINCE_ANNOTATION]: new Date(NOW).toISOString(),
      },
    }));
    const invalidTimestamp = createHarness(claim('active', new Date(NOW).toISOString(), {
      annotations: {
        [CLEANUP_OWNER_ANNOTATION]: OWNER,
        [CLEANUP_ARTIFACT_ANNOTATION]: ARTIFACT,
        [CLEANUP_STATE_ANNOTATION]: 'active',
        [CLEANUP_STATE_SINCE_ANNOTATION]: 'not-a-timestamp',
      },
    }));
    const misnamed = createHarness(claim('active', new Date(NOW).toISOString(), {
      name: 'unrelated-claim',
    }));

    for (const [harness, reason] of [
      [foreign, 'foreign-owner'],
      [unlabeled, 'missing-owner'],
      [incomplete, 'incomplete-cleanup-metadata'],
      [invalidArtifact, 'incomplete-cleanup-metadata'],
      [invalidTimestamp, 'incomplete-cleanup-metadata'],
      [misnamed, 'invalid-managed-metadata'],
    ] as const) {
      const result = await harness.provider.run(NOW);
      expect(result).toEqual([expect.objectContaining({ outcome: 'skipped', reason })]);
      expect(harness.api.patchPersistentVolumeClaimAnnotations).not.toHaveBeenCalled();
      expect(harness.api.deletePersistentVolumeClaim).not.toHaveBeenCalled();
    }
  });

  it('skips deletion when the PVC UID or metadata changes during the sweep', async () => {
    const harness = createHarness(claim('orphan-candidate', new Date(NOW - GRACE - 1).toISOString()));
    vi.mocked(harness.api.readPersistentVolumeClaim).mockImplementationOnce(async () => ({
      ...claim('orphan-candidate', new Date(NOW - GRACE - 1).toISOString()),
      uid: 'replacement-uid',
    }));

    const result = await harness.provider.run(NOW);

    expect(result).toEqual([expect.objectContaining({
      outcome: 'skipped', code: 'KUBERNETES_OBJECT_CHANGED',
    })]);
    expect(harness.api.deletePersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it('rechecks the managed PVC identity immediately before deletion', async () => {
    const harness = createHarness(claim('orphan-candidate', new Date(NOW - GRACE - 1).toISOString()));
    vi.mocked(harness.api.readPersistentVolumeClaim).mockImplementationOnce(async () => ({
      ...claim('orphan-candidate', new Date(NOW - GRACE - 1).toISOString()),
      labels: { [PART_OF_LABEL]: PART_OF_VALUE, [CONVERSATION_LABEL]: 'another-conversation' },
    }));

    const result = await harness.provider.run(NOW);

    expect(result).toEqual([expect.objectContaining({
      outcome: 'skipped', code: 'KUBERNETES_OBJECT_CHANGED',
    })]);
    expect(harness.api.deletePersistentVolumeClaim).not.toHaveBeenCalled();
  });
});
