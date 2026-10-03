import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instanceObjectName, instanceVolumeClaimName } from '../../../src/agent-runtime/runtimes/kubernetes.js';
import {
  K8S_NAMESPACE,
  assertKubernetesPrerequisites,
  deleteResource,
  kubectl,
  kubectlApply,
  kubectlJson,
  readLiveApiKey,
  resourceExists,
  startOrchestratorPortForward,
  waitFor,
  type PortForward,
} from '../../helpers/kubernetes.js';

interface Conversation {
  id: string;
  status: string;
  ready: boolean;
  sessionId?: string;
}

interface ConversationEvent {
  type: string;
  payload: Record<string, unknown>;
}

interface KubeObject {
  metadata: { uid?: string };
  spec?: { nodeName?: string; endpoint?: string };
  status?: {
    phase?: string;
    reachable?: boolean;
    currentEndpoint?: string;
    reportedBy?: string;
    migrationHistory?: Array<{ from?: string; to?: string; reason?: string; at?: string }>;
    conditions?: Array<{
      type?: string;
      status?: string;
      reason?: string;
      message?: string;
      lastTransitionTime?: string;
    }>;
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required; run this suite through npm run test:e2e:k3d`);
  return value;
}

describe('Kubernetes execute-mode cross-node migration (isolated k3d E2E)', () => {
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const successId = `k3d-move-${suffix}`;
  const failureId = `k3d-fail-${suffix}`;
  const storageClass = `ao-shared-${suffix}`;
  const sourceNode = requiredEnvironment('K8S_E2E_SOURCE_NODE');
  const targetNode = requiredEnvironment('K8S_E2E_TARGET_NODE');
  const sharedRoot = requiredEnvironment('K8S_E2E_SHARED_ROOT');
  const reconcileIntervalMs = Number(process.env.K8S_E2E_RECONCILE_INTERVAL_MS ?? '1000');
  let forward: PortForward;
  let apiKey: string;

  const authHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Connection: 'close',
  });

  const api = async (path: string, init?: RequestInit): Promise<Response> => {
    let lastError: unknown;
    const method = (init?.method ?? 'GET').toUpperCase();
    const attempts = method === 'GET' || method === 'HEAD' ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fetch(`${forward.baseUrl}${path}`, {
          ...init,
          headers: { ...authHeaders(), ...(init?.headers ?? {}) },
        });
      } catch (err) {
        lastError = err;
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
    }
    throw lastError;
  };

  const getConversation = async (id: string): Promise<Conversation> => {
    const response = await api(`/api/conversations/${id}`);
    if (!response.ok) throw new Error(`conversation status failed: ${response.status} ${await response.text()}`);
    return response.json() as Promise<Conversation>;
  };

  const waitUntilReady = async (id: string): Promise<Conversation> => {
    let current: Conversation | undefined;
    await waitFor(`${id} readiness`, async () => {
      current = await getConversation(id);
      return current.ready && typeof current.sessionId === 'string';
    }, 90_000);
    return current!;
  };

  const getInstance = (id: string): KubeObject => kubectlJson<KubeObject>([
    '-n', K8S_NAMESPACE, 'get', 'opencodeinstance', id,
  ]);

  const getRoute = (id: string): KubeObject => kubectlJson<KubeObject>([
    '-n', K8S_NAMESPACE, 'get', 'conversationroute', id,
  ]);

  const getPod = (id: string): KubeObject => kubectlJson<KubeObject>([
    '-n', K8S_NAMESPACE, 'get', 'pod', instanceObjectName(id),
  ]);

  const createSharedVolume = (id: string): { claimName: string; volumeName: string } => {
    const claimName = instanceVolumeClaimName(id);
    const volumeName = `pv-${id}`;
    kubectlApply({
      apiVersion: 'v1',
      kind: 'PersistentVolume',
      metadata: {
        name: volumeName,
        labels: { 'app.kubernetes.io/part-of': 'agent-orchestrator-e2e' },
      },
      spec: {
        capacity: { storage: '128Mi' },
        accessModes: ['ReadWriteOnce'],
        persistentVolumeReclaimPolicy: 'Retain',
        storageClassName: storageClass,
        hostPath: { path: `${sharedRoot}/${id}`, type: 'DirectoryOrCreate' },
      },
    });
    kubectlApply({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name: claimName,
        namespace: K8S_NAMESPACE,
        labels: {
          'app.kubernetes.io/part-of': 'agent-orchestrator',
          'agentorchestrator.io/conversation': id,
        },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: storageClass,
        volumeName,
        resources: { requests: { storage: '64Mi' } },
      },
    });
    kubectl([
      '-n', K8S_NAMESPACE,
      'wait', `persistentvolumeclaim/${claimName}`,
      '--for=jsonpath={.status.phase}=Bound',
      '--timeout=30s',
    ], 45_000);
    return { claimName, volumeName };
  };

  const patchInstanceStatus = (id: string, status: Record<string, unknown>): void => {
    kubectl([
      '-n', K8S_NAMESPACE,
      'patch', 'opencodeinstance', id,
      '--subresource=status',
      '--type=merge',
      '-p', JSON.stringify({ status }),
    ]);
  };

  const triggerQuotaMigration = (id: string): void => {
    patchInstanceStatus(id, {
      phase: 'QuotaExhausted',
      reachable: false,
      consecutiveFailures: 2,
      lastQuotaError: {
        code: 429,
        message: 'cross-node E2E trigger',
        at: new Date().toISOString(),
      },
    });
  };

  const createAndStart = async (id: string): Promise<Conversation> => {
    let response = await api('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    expect([201, 409]).toContain(response.status);
    response = await api(`/api/conversations/${id}/start`, { method: 'POST', body: '{}' });
    if (response.status !== 200) {
      throw new Error(`start ${id} failed: HTTP ${response.status}: ${await response.text()}`);
    }
    const conversation = await waitUntilReady(id);
    await waitFor(`${id} source placement and active route`, () => {
      const pod = getPod(id);
      const instance = getInstance(id);
      const route = getRoute(id);
      return pod.spec?.nodeName === sourceNode
        && instance.spec?.nodeName === sourceNode
        && instance.status?.phase === 'Ready'
        && typeof instance.status.reportedBy === 'string'
        && route.status?.phase === 'Active';
    }, 60_000);
    return conversation;
  };

  const writeSentinel = (id: string, value: string): void => {
    const path = `/data/conversations/${id}/workspace/cross-node-sentinel.txt`;
    kubectl(['-n', K8S_NAMESPACE, 'exec', instanceObjectName(id), '--', 'mkdir', '-p', `/data/conversations/${id}/workspace`]);
    kubectl([
      '-n', K8S_NAMESPACE, 'exec', instanceObjectName(id), '--',
      'sh', '-c', 'printf %s "$1" > "$2"', 'sh', value, path,
    ]);
  };

  const readSentinel = (id: string): string => kubectl([
    '-n', K8S_NAMESPACE, 'exec', instanceObjectName(id), '--',
    'cat', `/data/conversations/${id}/workspace/cross-node-sentinel.txt`,
  ]);

  const deleteConversation = async (id: string, volumeName: string): Promise<void> => {
    if (forward) {
      await api(`/api/conversations/${id}`, { method: 'DELETE' }).catch(() => undefined);
    }
    await waitFor(`${id} resource cleanup`, () =>
      !resourceExists('pod', instanceObjectName(id))
      && !resourceExists('service', instanceObjectName(id))
      && !resourceExists('pvc', instanceVolumeClaimName(id))
      && !resourceExists('opencodeinstance', id)
      && !resourceExists('conversationroute', id), 90_000).catch(() => undefined);
    deleteResource('pod', instanceObjectName(id));
    deleteResource('service', instanceObjectName(id));
    deleteResource('pvc', instanceVolumeClaimName(id));
    deleteResource('opencodeinstance', id);
    deleteResource('conversationroute', id);
    kubectl(['delete', 'persistentvolume', volumeName, '--ignore-not-found=true', '--wait=false']);
  };

  beforeAll(async () => {
    assertKubernetesPrerequisites();
    expect(sourceNode).not.toBe(targetNode);
    const nodes = kubectlJson<{ items: Array<{ metadata: { name: string } }> }>(['get', 'nodes']);
    expect(nodes.items.map((node) => node.metadata.name)).toEqual(expect.arrayContaining([sourceNode, targetNode]));
    const controller = kubectlJson<{ spec?: { template?: { spec?: { containers?: Array<{ args?: string[] }> } } } }>([
      '-n', K8S_NAMESPACE, 'get', 'deployment', 'placement-controller',
    ]);
    expect(controller.spec?.template?.spec?.containers?.[0]?.args).toContain('--execute');
    kubectlApply({
      apiVersion: 'storage.k8s.io/v1',
      kind: 'StorageClass',
      metadata: { name: storageClass },
      provisioner: 'kubernetes.io/no-provisioner',
      volumeBindingMode: 'Immediate',
    });
    apiKey = readLiveApiKey();
    forward = await startOrchestratorPortForward();
  });

  afterAll(async () => {
    if (forward) await forward.close();
    kubectl(['delete', 'storageclass', storageClass, '--ignore-not-found=true', '--wait=false']);
  });

  it('moves a live conversation to another worker once and resumes its persisted session', async () => {
    const { claimName, volumeName } = createSharedVolume(successId);
    try {
      const initial = await createAndStart(successId);
      const initialSessionId = initial.sessionId!;
      const initialPod = getPod(successId);
      const initialClaim = kubectlJson<KubeObject>(['-n', K8S_NAMESPACE, 'get', 'pvc', claimName]);
      const sentinel = `persisted-${suffix}`;
      writeSentinel(successId, sentinel);

      const observedRoutePhases = new Set<string>();
      triggerQuotaMigration(successId);
      await waitFor('execute-mode migration convergence', async () => {
        const route = getRoute(successId);
        if (route.status?.phase) observedRoutePhases.add(route.status.phase);
        const pod = getPod(successId);
        const instance = getInstance(successId);
        const conversation = await getConversation(successId);
        return pod.metadata.uid !== initialPod.metadata.uid
          && pod.spec?.nodeName === targetNode
          && instance.spec?.nodeName === targetNode
          && instance.status?.phase === 'Ready'
          && instance.status.reachable === true
          && route.status?.phase === 'Active'
          && route.status.currentEndpoint === instance.spec?.endpoint
          && route.status.conditions?.some((condition) =>
            condition.reason === 'MigrationCompleted'
            && condition.message?.includes('resumed=true')) === true
          && conversation.ready
          && conversation.sessionId === initialSessionId;
      }, 300_000);

      expect(observedRoutePhases).toContain('Migrating');
      expect(readSentinel(successId)).toBe(sentinel);
      expect(kubectlJson<KubeObject>(['-n', K8S_NAMESPACE, 'get', 'pvc', claimName]).metadata.uid)
        .toBe(initialClaim.metadata.uid);

      const route = getRoute(successId);
      expect(route.status?.migrationHistory).toHaveLength(1);
      expect(route.status?.migrationHistory?.[0]).toMatchObject({
        from: successId,
        to: successId,
        reason: `QuotaExhausted(${sourceNode}->${targetNode})`,
      });
      const eventsResponse = await api(`/api/conversations/${successId}/events?limit=100`);
      expect(eventsResponse.status).toBe(200);
      const events = await eventsResponse.json() as ConversationEvent[];
      expect(events.filter((event) => event.type === 'conversation.migrated')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ nodeName: targetNode, resumed: true, sessionId: initialSessionId }),
        }),
      ]);

      const settledPodUid = getPod(successId).metadata.uid;
      await new Promise((resolve) => setTimeout(resolve, reconcileIntervalMs * 3 + 500));
      expect(getPod(successId).metadata.uid).toBe(settledPodUid);
      expect(getRoute(successId).status?.migrationHistory).toHaveLength(1);
    } finally {
      await deleteConversation(successId, volumeName);
    }
  });

  it('quarantines a failed placement without retries and recovers on manual restart', async () => {
    const { claimName, volumeName } = createSharedVolume(failureId);
    const fakeNode = `aaa-dead-${suffix}`;
    try {
      const initial = await createAndStart(failureId);
      const initialSessionId = initial.sessionId!;
      const initialClaim = kubectlJson<KubeObject>(['-n', K8S_NAMESPACE, 'get', 'pvc', claimName]);
      const sentinel = `recovery-${suffix}`;
      writeSentinel(failureId, sentinel);

      kubectlApply({ apiVersion: 'v1', kind: 'Node', metadata: { name: fakeNode } });
      kubectl([
        'patch', 'node', fakeNode,
        '--subresource=status',
        '--type=merge',
        '-p', JSON.stringify({
          status: {
            conditions: [{
              type: 'Ready',
              status: 'True',
              reason: 'CrossNodeE2E',
              message: 'Synthetic ready node without a kubelet',
              lastHeartbeatTime: new Date().toISOString(),
              lastTransitionTime: new Date().toISOString(),
            }],
          },
        }),
      ]);

      const observedPodNodes = new Set<string>();
      triggerQuotaMigration(failureId);
      await waitFor('failed migration quarantine', () => {
        if (resourceExists('pod', instanceObjectName(failureId))) {
          const nodeName = getPod(failureId).spec?.nodeName;
          if (nodeName) observedPodNodes.add(nodeName);
        }
        const route = getRoute(failureId);
        return route.status?.phase === 'Migrating'
          && route.status.conditions?.some((condition) => condition.reason === 'MigrationFailed') === true;
      }, 180_000);

      expect(observedPodNodes).toContain(fakeNode);
      const failedRoute = getRoute(failureId);
      const failedCondition = failedRoute.status?.conditions?.find((condition) => condition.reason === 'MigrationFailed');
      expect(failedRoute.status?.migrationHistory ?? []).toHaveLength(0);
      expect(kubectlJson<KubeObject>(['-n', K8S_NAMESPACE, 'get', 'pvc', claimName]).metadata.uid)
        .toBe(initialClaim.metadata.uid);
      expect(getInstance(failureId).status?.phase).toBe('QuotaExhausted');
      expect(resourceExists('pod', instanceObjectName(failureId))).toBe(false);
      expect(resourceExists('service', instanceObjectName(failureId))).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, reconcileIntervalMs * 3 + 500));
      const stillFailed = getRoute(failureId);
      expect(stillFailed.status?.phase).toBe('Migrating');
      expect(stillFailed.status?.conditions?.find((condition) => condition.reason === 'MigrationFailed')?.lastTransitionTime)
        .toBe(failedCondition?.lastTransitionTime);
      expect(stillFailed.status?.migrationHistory ?? []).toHaveLength(0);

      kubectl(['delete', 'node', fakeNode, '--ignore-not-found=true', '--wait=true']);
      const restart = await api(`/api/conversations/${failureId}/restart`, { method: 'POST', body: '{}' });
      expect(restart.status).toBe(200);
      const recovered = await waitUntilReady(failureId);
      expect(recovered.sessionId).toBe(initialSessionId);
      await waitFor('failed migration recovery convergence', () => {
        const pod = getPod(failureId);
        const instance = getInstance(failureId);
        const route = getRoute(failureId);
        return pod.spec?.nodeName === sourceNode
          && instance.spec?.nodeName === sourceNode
          && instance.status?.phase === 'Ready'
          && route.status?.phase === 'Active'
          && route.status.currentEndpoint === instance.spec?.endpoint;
      }, 90_000);
      expect(readSentinel(failureId)).toBe(sentinel);
      expect(kubectlJson<KubeObject>(['-n', K8S_NAMESPACE, 'get', 'pvc', claimName]).metadata.uid)
        .toBe(initialClaim.metadata.uid);
    } finally {
      kubectl(['delete', 'node', fakeNode, '--ignore-not-found=true', '--wait=false']);
      await deleteConversation(failureId, volumeName);
    }
  });
});
