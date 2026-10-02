import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PortPool } from '../../orchestrator/port-pool.js';
import {
  KubernetesRuntime,
  sanitizeK8sName,
  instanceObjectName,
  instanceVolumeClaimName,
  instancePodLabelSelector,
  type InstancePodsApi,
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
  readImpl: (namespace: string, name: string) => Promise<{ phase?: string; ready?: boolean }>;
}

function createFakePods(): FakePods {
  const deletedPods = new Set<string>();
  const fake: FakePods = {
    createdPVCs: [],
    createdPods: [],
    createdServices: [],
    deleted: [],
    readImpl: async () => ({ phase: 'Running', ready: true }),
    api: null as unknown as InstancePodsApi,
  };
  const notFound = (): Error => {
    const err = new Error('not found') as Error & { statusCode: number };
    err.statusCode = 404;
    return err;
  };
  fake.api = {
    readPersistentVolumeClaim: vi.fn(async (namespace: string, name: string) => {
      const exists = fake.createdPVCs.some((pvc) =>
        pvc.namespace === namespace && (pvc.body.metadata as Record<string, unknown>).name === name,
      );
      if (!exists) throw notFound();
    }),
    createPersistentVolumeClaim: vi.fn(async (namespace: string, body: object) => {
      fake.createdPVCs.push({ namespace, body: body as Record<string, unknown> });
      return {};
    }),
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
      metadata: { name: 'conv-conv-1' },
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

  it('throws when Pod enters Failed phase', async () => {
    const fake = createFakePods();
    fake.readImpl = async () => ({ phase: 'Failed', ready: false });
    const rt = new KubernetesRuntime(createPortPool(), { image: 'img' }, fake.api);
    mockFetch.mockResolvedValue(makeHealthyFetch());

    await expect(rt.start('cf', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH)).rejects.toThrow(
      'entered phase Failed',
    );
  });

  it('throws on Pod ready timeout and releases the port', async () => {
    const fake = createFakePods();
    fake.readImpl = async () => ({ phase: 'Pending', ready: false });
    const pool = createPortPool(40000, 40000);
    const rt = new KubernetesRuntime(pool, { image: 'img', podReadyTimeoutMs: 50 }, fake.api);
    mockFetch.mockResolvedValue(makeHealthyFetch());

    await expect(rt.start('ct', '/tmp/ws', { username: 'u', password: 'p' }, HEALTH)).rejects.toThrow('not Ready in time');
    expect(await pool.allocate()).toBe(40000);
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
    fake.createdPVCs.push({ namespace: 'ao-instances', body: { metadata: { name: 'conv-existing' } } });
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
