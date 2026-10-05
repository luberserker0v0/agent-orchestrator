import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PortPool } from '../../orchestrator/port-pool.js';
import {
  CLEANUP_ARTIFACT_ANNOTATION,
  CLEANUP_OWNER_ANNOTATION,
  CLEANUP_STATE_ANNOTATION,
  CLEANUP_STATE_SINCE_ANNOTATION,
  CONVERSATION_LABEL,
  LivePodsApi,
  PART_OF_LABEL,
  PART_OF_VALUE,
  KubernetesRuntime,
  sanitizeK8sName,
  instanceObjectName,
  instanceVolumeClaimName,
  instancePodLabelSelector,
  persistentDataAnnotations,
  type InstancePodsApi,
  type PersistentVolumeClaimView,
} from './kubernetes.js';

function makeHealthyFetch() {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({ healthy: true, version: '1.0.0' }),
  };
}

function createPortPool(start = 40000, end = 40050): PortPool {
  return new PortPool(start, end, false);
}

interface FakePods {
  api: InstancePodsApi;
  createdPVCs: Array<{ namespace: string; body: Record<string, unknown> }>;
  createdPods: Array<{ namespace: string; body: Record<string, unknown> }>;
  createdServices: Array<{ namespace: string; body: Record<string, unknown> }>;
  deleted: string[];
  readImpl: (namespace: string, name: string) => Promise<{ phase?: string; ready?: boolean; nodeName?: string }>;
}

function managedPvcBody(
  name: string,
  conversationId: string,
  annotations: Record<string, string> = {},
): Record<string, unknown> {
  return {
    metadata: {
      name,
      uid: `uid-${name}`,
      resourceVersion: '1',
      labels: {
        [PART_OF_LABEL]: PART_OF_VALUE,
        [CONVERSATION_LABEL]: sanitizeK8sName(conversationId),
      },
      annotations,
    },
  };
}

function pvcView(body: Record<string, unknown>): PersistentVolumeClaimView {
  const metadata = body.metadata as {
    name: string;
    uid?: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  return {
    name: metadata.name,
    ...(metadata.uid ? { uid: metadata.uid } : {}),
    ...(metadata.resourceVersion ? { resourceVersion: metadata.resourceVersion } : {}),
    labels: { ...(metadata.labels ?? {}) },
    annotations: { ...(metadata.annotations ?? {}) },
  };
}

function createFakePods(): FakePods {
  const deletedPods = new Set<string>();
  const fake: FakePods = {
    createdPVCs: [],
    createdPods: [],
    createdServices: [],
    deleted: [],
    readImpl: async () => ({ phase: 'Running', ready: true, nodeName: 'worker-1' }),
    api: null as unknown as InstancePodsApi,
  };
  const notFound = (): Error => {
    const err = new Error('not found') as Error & { statusCode: number };
    err.statusCode = 404;
    return err;
  };
  fake.api = {
    readPersistentVolumeClaim: vi.fn(async (namespace: string, name: string) => {
      const found = fake.createdPVCs.find((pvc) =>
        pvc.namespace === namespace && (pvc.body.metadata as Record<string, unknown>).name === name,
      );
      if (!found) throw notFound();
      return pvcView(found.body);
    }),
    listManagedPersistentVolumeClaims: vi.fn(async (namespace: string) => fake.createdPVCs
      .filter((pvc) => pvc.namespace === namespace)
      .map((pvc) => pvcView(pvc.body))
      .filter((pvc) => pvc.labels[PART_OF_LABEL] === PART_OF_VALUE && pvc.labels[CONVERSATION_LABEL])),
    patchPersistentVolumeClaimAnnotations: vi.fn(async (
      namespace: string,
      name: string,
      expectedUid: string,
      expectedResourceVersion: string,
      annotations: Record<string, string>,
    ) => {
      const found = fake.createdPVCs.find((pvc) =>
        pvc.namespace === namespace && (pvc.body.metadata as Record<string, unknown>).name === name,
      );
      if (!found) throw notFound();
      const metadata = found.body.metadata as Record<string, unknown>;
      if (metadata.uid !== expectedUid) throw new Error('uid changed');
      if (metadata.resourceVersion !== expectedResourceVersion) throw new Error('resource version changed');
      metadata.annotations = { ...annotations };
      metadata.resourceVersion = String(Number(metadata.resourceVersion ?? 0) + 1);
      return pvcView(found.body);
    }),
    createPersistentVolumeClaim: vi.fn(async (namespace: string, body: object) => {
      const stored = structuredClone(body) as Record<string, unknown>;
      const metadata = stored.metadata as Record<string, unknown>;
      metadata.uid = `uid-${String(metadata.name)}`;
      metadata.resourceVersion = '1';
      fake.createdPVCs.push({ namespace, body: stored });
      return {};
    }),
    deletePersistentVolumeClaim: vi.fn(async (namespace: string, name: string, expectedUid?: string) => {
      const found = fake.createdPVCs.find((pvc) =>
        pvc.namespace === namespace && (pvc.body.metadata as Record<string, unknown>).name === name,
      );
      if (!found) throw notFound();
      if (expectedUid && (found.body.metadata as Record<string, unknown>).uid !== expectedUid) {
        throw new Error('uid changed');
      }
      fake.deleted.push(`pvc/${namespace}/${name}`);
      fake.createdPVCs = fake.createdPVCs.filter((pvc) =>
        pvc.namespace !== namespace || (pvc.body.metadata as Record<string, unknown>).name !== name,
      );
    }),
    listPodsReferencingPersistentVolumeClaim: vi.fn(async (namespace: string, claimName: string) => fake.createdPods
      .filter((pod) => pod.namespace === namespace)
      .filter((pod) => !deletedPods.has(`${namespace}/${String((pod.body.metadata as Record<string, unknown>).name)}`))
      .filter((pod) => {
        const spec = pod.body.spec as { volumes?: Array<{ persistentVolumeClaim?: { claimName?: string } }> };
        return (spec.volumes ?? []).some((volume) => volume.persistentVolumeClaim?.claimName === claimName);
      })
      .map((pod) => ({ name: String((pod.body.metadata as Record<string, unknown>).name) }))),
    createPod: vi.fn(async (namespace: string, body: object) => {
      fake.createdPods.push({ namespace, body: body as Record<string, unknown> });
      deletedPods.delete(`${namespace}/${((body as Record<string, unknown>).metadata as Record<string, unknown>).name}`);
    }),
    readPod: vi.fn(async (namespace: string, name: string) => {
      if (deletedPods.has(`${namespace}/${name}`)) throw notFound();
      return fake.readImpl(namespace, name);
    }),
    deletePod: vi.fn(async (namespace: string, name: string) => {
      fake.deleted.push(`pod/${namespace}/${name}`);
      deletedPods.add(`${namespace}/${name}`);
    }),
    createService: vi.fn(async (namespace: string, body: object) => {
      fake.createdServices.push({ namespace, body: body as Record<string, unknown> });
      return {};
    }),
    deleteService: vi.fn(async (namespace: string, name: string) => {
      fake.deleted.push(`svc/${namespace}/${name}`);
    }),
    listInstancePodNames: vi.fn(async () => fake.createdPods.map((p) => ((p.body.metadata as Record<string, unknown>).name as string))),
  };
  return fake;
}

const HEALTH = { retries: 2, intervalMs: 1, clientTimeoutMs: 5000 };

it('uses the conversation label to select only managed instance Pods', () => {
  expect(instancePodLabelSelector()).toBe(
    'app.kubernetes.io/part-of=agent-orchestrator,agentorchestrator.io/conversation',
  );
});

describe('sanitizeK8sName', () => {
  it('lowercases and strips invalid characters', () => {
    expect(sanitizeK8sName('Conv_ABC.123')).toBe('conv-abc-123');
  });

  it('falls back for empty results', () => {
    expect(sanitizeK8sName('...')).toBe('conv');
  });
});

describe('naming', () => {
  it('builds stable object and claim names', () => {
    expect(instanceObjectName('AbC')).toBe('opencode-abc');
    expect(instanceVolumeClaimName('AbC')).toBe('conv-abc');
  });
});

describe('KubernetesRuntime', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('exposes type and capabilities', () => {
    const rt = new KubernetesRuntime(createPortPool(), { image: 'img' });
    expect(rt.type).toBe('kubernetes');
    expect(rt.capabilities.sessions).toBe(true);
  });

  it('creates Service and Pod, waits ready, returns Service-DNS baseUrl', async () => {
    const fake = createFakePods();
    const rt = new KubernetesRuntime(createPortPool(), { image: 'test-image' }, fake.api);
    mockFetch.mockResolvedValue(makeHealthyFetch());

    const result = await rt.start('conv-1', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH);

    expect(fake.createdPVCs).toHaveLength(1);
    expect(fake.createdPVCs[0].body).toMatchObject({
      metadata: {
        name: 'conv-conv-1',
        annotations: {
          [CLEANUP_OWNER_ANNOTATION]: 'agent-orchestrator',
          [CLEANUP_STATE_ANNOTATION]: 'active',
          [CLEANUP_ARTIFACT_ANNOTATION]: expect.any(String),
          [CLEANUP_STATE_SINCE_ANNOTATION]: expect.any(String),
        },
      },
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '10Gi' } } },
    });
    expect(fake.createdServices).toHaveLength(1);
    expect(fake.createdPods).toHaveLength(1);
    const pod = fake.createdPods[0].body;
    const container = ((pod.spec as Record<string, unknown>).containers as Array<Record<string, unknown>>)[0];
    expect(container.image).toBe('test-image');
    expect(container.args).toContain('--hostname');
    expect(container.env).toContainEqual({ name: 'XDG_DATA_HOME', value: '/data/conversations/conv-1/session' });
    expect(container.workingDir).toBe('/data/conversations/conv-1/workspace');
    expect(result.baseUrl).toBe(`http://opencode-conv-1.ao-instances.svc.cluster.local:${result.port}`);
    expect(result.nodeName).toBe('worker-1');
    expect(result.handle).toBeDefined();
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/global/health'), expect.anything());
  });

  it('uses instanceHost override in baseUrl', async () => {
    const fake = createFakePods();
    const rt = new KubernetesRuntime(createPortPool(), { image: 'img', instanceHost: '10.0.0.1' }, fake.api);
    mockFetch.mockResolvedValue(makeHealthyFetch());

    const result = await rt.start('c2', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH);

    expect(result.baseUrl).toBe(`http://10.0.0.1:${result.port}`);
  });

  it('adds OPENCODE_DB env in sqlite mode and pins nodeName', async () => {
    const fake = createFakePods();
    const rt = new KubernetesRuntime(
      createPortPool(),
      { image: 'img', sessionMode: 'sqlite', nodeName: 'worker-2' },
      fake.api,
    );
    mockFetch.mockResolvedValue(makeHealthyFetch());

    await rt.start('c3', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH);

    const pod = fake.createdPods[0].body;
    const container = ((pod.spec as Record<string, unknown>).containers as Array<Record<string, unknown>>)[0];
    expect(container.env).toContainEqual({ name: 'OPENCODE_DB', value: '/data/conversations/c3/session/opencode.db' });
    expect((pod.spec as Record<string, unknown>).nodeName).toBe('worker-2');
  });

  it('authenticates kubelet probes with Basic auth', async () => {
    const fake = createFakePods();
    const rt = new KubernetesRuntime(createPortPool(), { image: 'img' }, fake.api);
    mockFetch.mockResolvedValue(makeHealthyFetch());

    await rt.start('c4', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH);

    const pod = fake.createdPods[0].body;
    const container = ((pod.spec as Record<string, unknown>).containers as Array<Record<string, unknown>>)[0];
    const expected = `Basic ${Buffer.from('u:p').toString('base64')}`;
    for (const probe of [container.livenessProbe, container.readinessProbe]) {
      const httpGet = (probe as Record<string, unknown>).httpGet as Record<string, unknown>;
      expect(httpGet.httpHeaders).toEqual([{ name: 'Authorization', value: expected }]);
    }
  });

  it('waits for a failed Pod to disappear before rejecting start', async () => {
    const fake = createFakePods();
    let deletionRequested = false;
    let confirmPodGone!: () => void;
    const podGone = new Promise<void>((resolve) => {
      confirmPodGone = resolve;
    });
    (fake.api.deletePod as ReturnType<typeof vi.fn>).mockImplementation(async (namespace: string, name: string) => {
      fake.deleted.push(`pod/${namespace}/${name}`);
      deletionRequested = true;
    });
    (fake.api.readPod as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (!deletionRequested) return { phase: 'Failed', ready: false };
      await podGone;
      const err = new Error('gone') as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    });
    const rt = new KubernetesRuntime(createPortPool(), { image: 'img' }, fake.api);
    mockFetch.mockResolvedValue(makeHealthyFetch());

    let settled = false;
    const outcome = rt.start('cf', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH).then(
      () => {
        settled = true;
        return new Error('start unexpectedly resolved');
      },
      (err: unknown) => {
        settled = true;
        return err as Error;
      },
    );

    await vi.waitFor(() => {
      expect(fake.api.deletePod).toHaveBeenCalledWith('ao-instances', 'opencode-cf');
      expect(fake.api.readPod).toHaveBeenCalledTimes(2);
    });
    expect(settled).toBe(false);

    confirmPodGone();
    const error = await outcome;
    expect(error.message).toContain('entered phase Failed');
  });

  it('throws on Pod ready timeout and releases the port', async () => {
    const fake = createFakePods();
    fake.readImpl = async () => ({ phase: 'Pending', ready: false });
    const pool = createPortPool(40000, 40000);
    const rt = new KubernetesRuntime(pool, { image: 'img', podReadyTimeoutMs: 50 }, fake.api);
    mockFetch.mockResolvedValue(makeHealthyFetch());

    await expect(rt.start('ct', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH)).rejects.toThrow('not Ready in time');
    expect(await pool.allocate()).toBe(40000);
    expect(fake.createdPVCs).toHaveLength(0);
    expect(fake.deleted).toContain('pvc/ao-instances/conv-ct');
  });

  it('retains a pre-existing PVC when startup fails', async () => {
    const fake = createFakePods();
    fake.createdPVCs.push({
      namespace: 'ao-instances',
      body: managedPvcBody('conv-existing', 'existing'),
    });
    fake.readImpl = async () => ({ phase: 'Pending', ready: false });
    const rt = new KubernetesRuntime(
      createPortPool(),
      { image: 'img', podReadyTimeoutMs: 50 },
      fake.api,
    );

    await expect(rt.start(
      'existing',
      '/tmp/ws',
      { username: 'u', password: 'p' },
      HEALTH,
    )).rejects.toThrow('not Ready in time');

    expect(fake.createdPVCs).toHaveLength(1);
    expect(fake.deleted).not.toContain('pvc/ao-instances/conv-existing');
  });

  it('deletes persistent data explicitly', async () => {
    const fake = createFakePods();
    fake.createdPVCs.push({
      namespace: 'ao-instances',
      body: managedPvcBody(
        'conv-delete-me',
        'delete-me',
        persistentDataAnnotations('agent-orchestrator', 'active'),
      ),
    });
    const rt = new KubernetesRuntime(createPortPool(), { image: 'img' }, fake.api);

    await rt.deletePersistentData('delete-me');

    expect(fake.createdPVCs).toHaveLength(0);
    expect(fake.deleted).toContain('pvc/ao-instances/conv-delete-me');
  });

  it('restart deletes and recreates Pod and Service with a new port', async () => {
    const fake = createFakePods();
    const rt = new KubernetesRuntime(createPortPool(40000, 40001), { image: 'img' }, fake.api);
    mockFetch.mockResolvedValue(makeHealthyFetch());

    const first = await rt.start('cr', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH);
    const second = await rt.restart('cr', HEALTH);

    expect(fake.deleted).toContain('pod/ao-instances/opencode-cr');
    expect(fake.deleted).toContain('svc/ao-instances/opencode-cr');
    expect(fake.createdPods).toHaveLength(2);
    expect(second.port).not.toBe(first.port);
    expect(second.baseUrl).toContain('opencode-cr.ao-instances.svc.cluster.local');
  });

  it('marks deletion intent before stopping and preserves the marker on retry', async () => {
    const fake = createFakePods();
    fake.createdPVCs.push({
      namespace: 'ao-instances',
      body: managedPvcBody(
        'conv-delete-me',
        'delete-me',
        persistentDataAnnotations('owner-a', 'active'),
      ),
    });
    const rt = new KubernetesRuntime(
      createPortPool(),
      { image: 'img', cleanupOwnerId: 'owner-a' },
      fake.api,
    );

    await rt.preparePersistentDataDeletion('delete-me');
    const first = pvcView(fake.createdPVCs[0].body);
    await rt.preparePersistentDataDeletion('delete-me');
    const second = pvcView(fake.createdPVCs[0].body);

    expect(first.annotations).toMatchObject({
      [CLEANUP_OWNER_ANNOTATION]: 'owner-a',
      [CLEANUP_STATE_ANNOTATION]: 'delete-pending',
      [CLEANUP_ARTIFACT_ANNOTATION]: expect.any(String),
      [CLEANUP_STATE_SINCE_ANNOTATION]: expect.any(String),
    });
    expect(second.annotations).toEqual(first.annotations);
    expect(fake.deleted).toEqual([]);
  });

  it('refuses to delete a PVC while any Pod still references it', async () => {
    const fake = createFakePods();
    fake.createdPVCs.push({
      namespace: 'ao-instances',
      body: managedPvcBody(
        'conv-in-use',
        'in-use',
        persistentDataAnnotations('agent-orchestrator', 'active'),
      ),
    });
    fake.createdPods.push({
      namespace: 'ao-instances',
      body: {
        metadata: { name: 'foreign-reader' },
        spec: { volumes: [{ persistentVolumeClaim: { claimName: 'conv-in-use' } }] },
      },
    });
    const rt = new KubernetesRuntime(createPortPool(), { image: 'img' }, fake.api);

    await expect(rt.deletePersistentData('in-use')).rejects.toThrow('still referenced');

    expect(fake.createdPVCs).toHaveLength(1);
    expect((fake.api.deletePersistentVolumeClaim as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('revalidates managed PVC ownership immediately before explicit deletion', async () => {
    const fake = createFakePods();
    fake.createdPVCs.push({
      namespace: 'ao-instances',
      body: managedPvcBody(
        'conv-delete-me',
        'delete-me',
        persistentDataAnnotations('agent-orchestrator', 'active'),
      ),
    });
    vi.mocked(fake.api.listPodsReferencingPersistentVolumeClaim).mockImplementationOnce(async () => {
      const metadata = fake.createdPVCs[0].body.metadata as {
        labels: Record<string, string>;
      };
      metadata.labels = {};
      return [];
    });
    const rt = new KubernetesRuntime(createPortPool(), { image: 'img' }, fake.api);

    await expect(rt.deletePersistentData('delete-me')).rejects.toThrow('unmanaged');

    expect(fake.createdPVCs).toHaveLength(1);
    expect(fake.api.deletePersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it('refuses foreign and unmanaged PVCs', async () => {
    const fake = createFakePods();
    fake.createdPVCs.push({
      namespace: 'ao-instances',
      body: managedPvcBody('conv-foreign', 'foreign', { [CLEANUP_OWNER_ANNOTATION]: 'other-owner' }),
    });
    const rt = new KubernetesRuntime(
      createPortPool(),
      { image: 'img', cleanupOwnerId: 'owner-a' },
      fake.api,
    );

    await expect(rt.preparePersistentDataDeletion('foreign')).rejects.toThrow('owned by another orchestrator');
    expect(fake.createdPVCs).toHaveLength(1);

    const metadata = fake.createdPVCs[0].body.metadata as {
      labels: Record<string, string>;
      annotations: Record<string, string>;
    };
    metadata.annotations = {};
    await expect(rt.preparePersistentDataDeletion('foreign')).rejects.toThrow('without complete cleanup ownership metadata');

    metadata.annotations = {
      ...persistentDataAnnotations('owner-a', 'active'),
      [CLEANUP_ARTIFACT_ANNOTATION]: 'not-a-uuid',
    };
    await expect(rt.preparePersistentDataDeletion('foreign')).rejects.toThrow('invalid cleanup artifact id');

    metadata.annotations = {
      ...persistentDataAnnotations('owner-a', 'active'),
      [CLEANUP_STATE_SINCE_ANNOTATION]: 'not-a-timestamp',
    };
    await expect(rt.preparePersistentDataDeletion('foreign')).rejects.toThrow('invalid cleanup timestamp');

    metadata.labels = {};
    await expect(rt.preparePersistentDataDeletion('foreign')).rejects.toThrow('unmanaged');
    expect(fake.createdPVCs).toHaveLength(1);
  });

  it('blocks same-id reuse while the old PVC is delete-pending', async () => {
    const fake = createFakePods();
    fake.createdPVCs.push({
      namespace: 'ao-instances',
      body: managedPvcBody('conv-pending', 'pending', {
        [CLEANUP_OWNER_ANNOTATION]: 'owner-a',
        [CLEANUP_ARTIFACT_ANNOTATION]: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        [CLEANUP_STATE_ANNOTATION]: 'delete-pending',
        [CLEANUP_STATE_SINCE_ANNOTATION]: new Date().toISOString(),
      }),
    });
    const rt = new KubernetesRuntime(
      createPortPool(),
      { image: 'img', cleanupOwnerId: 'owner-a' },
      fake.api,
    );

    await expect(rt.start('pending', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH))
      .rejects.toMatchObject({ code: 'PERSISTENT_DATA_CLEANUP_PENDING' });
    expect(fake.createdPods).toHaveLength(0);
  });

  it('restart throws without stored state', async () => {
    const fake = createFakePods();
    const rt = new KubernetesRuntime(createPortPool(), { image: 'img' }, fake.api);
    await expect(rt.restart('missing', HEALTH)).rejects.toThrow('No stored state');
  });

  it('restart deletes gracefully and waits for termination before recreating', async () => {
    const fake = createFakePods();
    const rt = new KubernetesRuntime(createPortPool(40000, 40001), { image: 'img' }, fake.api);
    mockFetch.mockResolvedValue(makeHealthyFetch());

    await rt.start('cw', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH);

    let reads = 0;
    (fake.api.readPod as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      reads++;
      if (reads === 4) {
        const err = new Error('gone') as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      }
      return { phase: 'Running', ready: true };
    });

    await rt.restart('cw', HEALTH);

    expect(fake.api.deletePod).toHaveBeenCalledWith('ao-instances', 'opencode-cw');
    expect(fake.createdPods).toHaveLength(2);
  });

  it('waits for a failed replacement Pod to disappear before rejecting restart', async () => {
    const fake = createFakePods();
    const rt = new KubernetesRuntime(createPortPool(40000, 40001), { image: 'img' }, fake.api);
    mockFetch.mockResolvedValue(makeHealthyFetch());

    await rt.start('restart-failure', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH);

    let deleteCalls = 0;
    let confirmPodGone!: () => void;
    const podGone = new Promise<void>((resolve) => {
      confirmPodGone = resolve;
    });
    (fake.api.deletePod as ReturnType<typeof vi.fn>).mockImplementation(async (namespace: string, name: string) => {
      fake.deleted.push(`pod/${namespace}/${name}`);
      deleteCalls++;
    });
    (fake.api.readPod as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (fake.createdPods.length === 1 && deleteCalls === 1) {
        const err = new Error('gone') as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      }
      if (fake.createdPods.length === 2 && deleteCalls === 1) {
        return { phase: 'Failed', ready: false };
      }
      if (fake.createdPods.length === 2 && deleteCalls === 2) {
        await podGone;
        const err = new Error('gone') as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      }
      return { phase: 'Running', ready: true };
    });

    let settled = false;
    const outcome = rt.restart('restart-failure', HEALTH).then(
      () => {
        settled = true;
        return new Error('restart unexpectedly resolved');
      },
      (err: unknown) => {
        settled = true;
        return err as Error;
      },
    );

    await vi.waitFor(() => {
      expect(fake.api.deletePod).toHaveBeenCalledTimes(2);
      expect(fake.api.readPod).toHaveBeenCalledTimes(4);
    });
    expect(settled).toBe(false);

    confirmPodGone();
    const error = await outcome;
    expect(error.message).toContain('entered phase Failed');
  });

  it('stop kills Pod and Service, tolerating missing objects', async () => {
    const fake = createFakePods();
    const rt = new KubernetesRuntime(createPortPool(), { image: 'img' }, fake.api);
    mockFetch.mockResolvedValue(makeHealthyFetch());

    const result = await rt.start('cs', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH);
    await rt.stop(result.handle);

    expect(fake.deleted).toContain('pod/ao-instances/opencode-cs');
    expect(fake.deleted).toContain('svc/ao-instances/opencode-cs');
    await expect(rt.stop(undefined)).resolves.toBeUndefined();
  });

  it('fires onExit when the Pod disappears', async () => {
    const fake = createFakePods();
    const rt = new KubernetesRuntime(createPortPool(), { image: 'img' }, fake.api);
    mockFetch.mockResolvedValue(makeHealthyFetch());

    const result = await rt.start('ce', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH);
    fake.readImpl = async () => {
      const err = new Error('gone') as Error & { statusCode: number };
      err.statusCode = 404;
      throw err;
    };
    const code = await new Promise<number | null>((resolve) => {
      result.handle!.onExit(resolve);
    });
    expect(code).toBeNull();
  });

  describe('node overrides', () => {
    it('prefers setNodeOverride over config nodeName', async () => {
      const fake = createFakePods();
      const rt = new KubernetesRuntime(createPortPool(), { image: 'img', nodeName: 'cfg-node' }, fake.api);
      mockFetch.mockResolvedValue(makeHealthyFetch());

      rt.setNodeOverride('cn', 'target-node');
      await rt.start('cn', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH);

      expect((fake.createdPods[0].body.spec as Record<string, unknown>).nodeName).toBe('target-node');
    });

    it('falls back to config nodeName and clears overrides', async () => {
      const fake = createFakePods();
      const rt = new KubernetesRuntime(createPortPool(), { image: 'img', nodeName: 'cfg-node' }, fake.api);
      mockFetch.mockResolvedValue(makeHealthyFetch());

      rt.setNodeOverride('cn', 'target-node');
      rt.clearNodeOverride('cn');
      await rt.start('cn', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH);

      expect((fake.createdPods[0].body.spec as Record<string, unknown>).nodeName).toBe('cfg-node');
    });

    it('omits nodeName when neither override nor config sets it', async () => {
      const fake = createFakePods();
      const rt = new KubernetesRuntime(createPortPool(), { image: 'img' }, fake.api);
      mockFetch.mockResolvedValue(makeHealthyFetch());

      await rt.start('cn', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH);

      expect((fake.createdPods[0].body.spec as Record<string, unknown>)).not.toHaveProperty('nodeName');
    });
  });

  it('cleanupOrphans deletes listed Pods and their Services', async () => {
    const fake = createFakePods();
    const rt = new KubernetesRuntime(createPortPool(), { image: 'img' }, fake.api);
    fake.createdPods.push({ namespace: 'ao-instances', body: { metadata: { name: 'opencode-old' } } });

    await rt.cleanupOrphans();

    expect(fake.deleted).toContain('pod/ao-instances/opencode-old');
    expect(fake.deleted).toContain('svc/ao-instances/opencode-old');
  });

  it('reuses an existing conversation PVC', async () => {
    const fake = createFakePods();
    fake.createdPVCs.push({ namespace: 'ao-instances', body: managedPvcBody('conv-existing', 'existing') });
    const createPVC = fake.api.createPersistentVolumeClaim as ReturnType<typeof vi.fn>;
    const rt = new KubernetesRuntime(createPortPool(), { image: 'img' }, fake.api);
    mockFetch.mockResolvedValue(makeHealthyFetch());

    await rt.start('existing', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH);

    expect(createPVC).not.toHaveBeenCalled();
  });

  it('labels instance Pods distinctly from orchestrator control-plane Pods', async () => {
    const fake = createFakePods();
    const rt = new KubernetesRuntime(createPortPool(), { image: 'img' }, fake.api);
    mockFetch.mockResolvedValue(makeHealthyFetch());

    await rt.start('label-check', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH);

    const metadata = fake.createdPods[0].body.metadata as { labels: Record<string, string> };
    expect(metadata.labels['app.kubernetes.io/part-of']).toBe('agent-orchestrator');
    expect(metadata.labels['agentorchestrator.io/conversation']).toBe('label-check');
  });
});

describe('LivePodsApi cleanup primitives', () => {
  it('lists managed claims, patches with resourceVersion, and deletes with a UID precondition', async () => {
    const claim = {
      metadata: {
        name: 'conv-a', uid: 'uid-a', resourceVersion: '7',
        labels: { [PART_OF_LABEL]: PART_OF_VALUE, [CONVERSATION_LABEL]: 'a' },
        annotations: {},
      },
    };
    const coreApi = {
      readNamespacedPersistentVolumeClaim: vi.fn(async () => claim),
      listNamespacedPersistentVolumeClaim: vi.fn(async () => ({ items: [claim] })),
      patchNamespacedPersistentVolumeClaim: vi.fn(async () => ({
        ...claim,
        metadata: { ...claim.metadata, annotations: { [CLEANUP_STATE_ANNOTATION]: 'orphan-candidate' } },
      })),
      deleteNamespacedPersistentVolumeClaim: vi.fn(async () => claim),
      listNamespacedPod: vi.fn(async () => ({ items: [] })),
    };
    const api = new LivePodsApi(coreApi as never);

    expect(await api.listManagedPersistentVolumeClaims('ns')).toHaveLength(1);
    await api.patchPersistentVolumeClaimAnnotations('ns', 'conv-a', 'uid-a', '7', {
      [CLEANUP_STATE_ANNOTATION]: 'orphan-candidate',
    });
    await api.deletePersistentVolumeClaim('ns', 'conv-a', 'uid-a');

    expect(coreApi.listNamespacedPersistentVolumeClaim).toHaveBeenCalledWith(
      'ns', undefined, undefined, undefined, undefined,
      'app.kubernetes.io/part-of=agent-orchestrator,agentorchestrator.io/conversation',
    );
    expect(coreApi.patchNamespacedPersistentVolumeClaim).toHaveBeenCalledWith(
      'conv-a', 'ns',
      [
        { op: 'test', path: '/metadata/uid', value: 'uid-a' },
        { op: 'test', path: '/metadata/resourceVersion', value: '7' },
        { op: 'add', path: '/metadata/annotations', value: { [CLEANUP_STATE_ANNOTATION]: 'orphan-candidate' } },
      ],
    );
    expect(coreApi.deleteNamespacedPersistentVolumeClaim).toHaveBeenCalledWith(
      'conv-a', 'ns',
      undefined, undefined, undefined, undefined, undefined, undefined,
      { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'uid-a' } },
    );
  });

  it('rejects annotation updates when ownership changed after the caller read the PVC', async () => {
    const claim = {
      metadata: {
        name: 'conv-a', uid: 'uid-a', resourceVersion: '8',
        labels: { [PART_OF_LABEL]: PART_OF_VALUE, [CONVERSATION_LABEL]: 'a' },
        annotations: persistentDataAnnotations('another-owner', 'active'),
      },
    };
    const coreApi = {
      readNamespacedPersistentVolumeClaim: vi.fn(async () => claim),
      patchNamespacedPersistentVolumeClaim: vi.fn(),
    };
    const api = new LivePodsApi(coreApi as never);

    await expect(api.patchPersistentVolumeClaimAnnotations(
      'ns',
      'conv-a',
      'uid-a',
      '7',
      persistentDataAnnotations('owner-a', 'orphan-candidate'),
    )).rejects.toThrow('resourceVersion changed');
    expect(coreApi.patchNamespacedPersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it('finds every Pod that references a claim', async () => {
    const coreApi = {
      listNamespacedPod: vi.fn(async () => ({
        items: [
          {
            metadata: { name: 'reader', uid: 'pod-1' },
            spec: { volumes: [{ persistentVolumeClaim: { claimName: 'conv-a' } }] },
            status: { phase: 'Running' },
          },
          {
            metadata: { name: 'other' },
            spec: { volumes: [{ persistentVolumeClaim: { claimName: 'conv-b' } }] },
          },
        ],
      })),
    };
    const api = new LivePodsApi(coreApi as never);

    expect(await api.listPodsReferencingPersistentVolumeClaim('ns', 'conv-a')).toEqual([
      { name: 'reader', uid: 'pod-1', phase: 'Running' },
    ]);
  });
});
