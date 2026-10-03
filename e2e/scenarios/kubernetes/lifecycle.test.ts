import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PortPool } from '../../../src/orchestrator/port-pool.js';
import { KubernetesRuntime, instanceObjectName, instanceVolumeClaimName } from '../../../src/agent-runtime/runtimes/kubernetes.js';
import {
  K8S_NAMESPACE,
  assertKubernetesPrerequisites,
  deleteResource,
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

interface KubeObject {
  metadata: { uid?: string };
  spec?: { nodeName?: string; endpoint?: string };
  status?: {
    phase?: string;
    reachable?: boolean;
    currentEndpoint?: string;
    conditions?: Array<{ type?: string; status?: string; reason?: string }>;
  };
}

describe('Kubernetes lifecycle (k3d E2E)', () => {
  const suffix = `${process.pid}-${Date.now().toString(36)}`;
  const conversationId = `k8s-e2e-${suffix}`;
  const failureId = `k8s-fail-${suffix}`;
  const raceId = `k8s-race-${suffix}`;
  let forward: PortForward;
  let apiKey: string;
  let primaryDeleted = false;

  const authHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  });

  const api = (path: string, init?: RequestInit): Promise<Response> => fetch(`${forward.baseUrl}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init?.headers ?? {}) },
  });

  const getConversation = async (): Promise<Conversation> => {
    const response = await api(`/api/conversations/${conversationId}`);
    if (!response.ok) throw new Error(`conversation status failed: ${response.status} ${await response.text()}`);
    return response.json() as Promise<Conversation>;
  };

  const waitUntilReady = async (): Promise<Conversation> => {
    let current: Conversation | undefined;
    await waitFor('conversation readiness', async () => {
      current = await getConversation();
      return current.ready && typeof current.sessionId === 'string';
    }, 90_000);
    return current!;
  };

  const cleanupNamedResources = (id: string): void => {
    deleteResource('pod', instanceObjectName(id));
    deleteResource('service', instanceObjectName(id));
    deleteResource('opencodeinstance', id);
    deleteResource('conversationroute', id);
    deleteResource('pvc', instanceVolumeClaimName(id));
  };

  const getInstanceResource = (): KubeObject => kubectlJson<KubeObject>([
    '-n', K8S_NAMESPACE, 'get', 'opencodeinstance', conversationId,
  ]);

  const getRouteResource = (): KubeObject => kubectlJson<KubeObject>([
    '-n', K8S_NAMESPACE, 'get', 'conversationroute', conversationId,
  ]);

  beforeAll(async () => {
    assertKubernetesPrerequisites();
    apiKey = readLiveApiKey();
    cleanupNamedResources(conversationId);
    cleanupNamedResources(failureId);
    cleanupNamedResources(raceId);
    forward = await startOrchestratorPortForward();
  });

  afterAll(async () => {
    if (forward) {
      if (!primaryDeleted) {
        await api(`/api/conversations/${conversationId}`, { method: 'DELETE' }).catch(() => undefined);
      }
      await forward.close();
    }
    cleanupNamedResources(conversationId);
    cleanupNamedResources(failureId);
    cleanupNamedResources(raceId);
  });

  it('enforces API authentication and accepts the configured admin key', async () => {
    const unauthorized = await fetch(`${forward.baseUrl}/api/conversations`);
    expect(unauthorized.status).toBe(401);

    const authorized = await api('/api/auth/role');
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({ role: 'admin' });
  });

  it('persists one session across stop, restart, and same-node migration, then garbage-collects everything', async () => {
    let response = await api('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ id: conversationId }),
    });
    expect(response.status).toBe(201);

    response = await api(`/api/conversations/${conversationId}/start`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);
    const firstReady = await waitUntilReady();
    const firstSessionId = firstReady.sessionId!;

    const pvcName = instanceVolumeClaimName(conversationId);
    const podName = instanceObjectName(conversationId);
    const firstPVC = kubectlJson<KubeObject>(['-n', K8S_NAMESPACE, 'get', 'pvc', pvcName]);
    const firstPod = kubectlJson<KubeObject>(['-n', K8S_NAMESPACE, 'get', 'pod', podName]);
    const sourceNode = firstPod.spec?.nodeName;
    expect(firstPVC.status?.phase).toBe('Bound');
    expect(sourceNode).toBeTruthy();

    await waitFor('Ready OpencodeInstance on the actual Pod node', () => {
      const instance = getInstanceResource();
      return instance.status?.phase === 'Ready'
        && instance.status.reachable === true
        && instance.spec?.nodeName === sourceNode
        && typeof instance.spec?.endpoint === 'string';
    });
    await waitFor('Active ConversationRoute with the instance endpoint', () => {
      const instance = getInstanceResource();
      const route = getRouteResource();
      return route.status?.phase === 'Active'
        && route.status.currentEndpoint === instance.spec?.endpoint;
    });

    response = await api(`/api/conversations/${conversationId}/stop`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);
    await waitFor('instance Pod and Service deletion', () =>
      !resourceExists('pod', podName) && !resourceExists('service', podName), 60_000);
    expect(kubectlJson<KubeObject>(['-n', K8S_NAMESPACE, 'get', 'pvc', pvcName]).metadata.uid)
      .toBe(firstPVC.metadata.uid);
    await waitFor('Stopped status and non-routable route', () => {
      const instance = getInstanceResource();
      const route = getRouteResource();
      return instance.status?.phase === 'Stopped'
        && instance.status.reachable === false
        && route.status?.phase === 'Draining'
        && route.status.conditions?.some((condition) =>
          condition.type === 'Routable'
          && condition.status === 'False'
          && condition.reason === 'InstanceStopped') === true;
    }, 60_000);

    response = await api(`/api/conversations/${conversationId}/restart`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);
    const restarted = await waitUntilReady();
    expect(restarted.sessionId).toBe(firstSessionId);
    expect(kubectlJson<KubeObject>(['-n', K8S_NAMESPACE, 'get', 'pvc', pvcName]).metadata.uid)
      .toBe(firstPVC.metadata.uid);
    await waitFor('restart status and route reconciliation', () => {
      const pod = kubectlJson<KubeObject>(['-n', K8S_NAMESPACE, 'get', 'pod', podName]);
      const instance = getInstanceResource();
      const route = getRouteResource();
      return instance.status?.phase === 'Ready'
        && instance.status.reachable === true
        && instance.spec?.nodeName === pod.spec?.nodeName
        && route.status?.phase === 'Active'
        && route.status.currentEndpoint === instance.spec?.endpoint;
    }, 60_000);

    response = await api(`/api/conversations/${conversationId}/migrate`, {
      method: 'POST',
      body: JSON.stringify({ nodeName: sourceNode }),
    });
    expect(response.status).toBe(200);
    const migrated = await response.json() as { resumed?: boolean; sessionId?: string; nodeName?: string };
    expect(migrated).toMatchObject({ resumed: true, sessionId: firstSessionId, nodeName: sourceNode });
    await waitUntilReady();
    expect(kubectlJson<KubeObject>(['-n', K8S_NAMESPACE, 'get', 'pvc', pvcName]).metadata.uid)
      .toBe(firstPVC.metadata.uid);
    await waitFor('migration placement and route convergence', () => {
      const pod = kubectlJson<KubeObject>(['-n', K8S_NAMESPACE, 'get', 'pod', podName]);
      const instance = getInstanceResource();
      const route = getRouteResource();
      return pod.spec?.nodeName === sourceNode
        && instance.spec?.nodeName === sourceNode
        && instance.status?.phase === 'Ready'
        && instance.status.reachable === true
        && route.status?.phase === 'Active'
        && route.status.currentEndpoint === instance.spec?.endpoint;
    }, 60_000);

    response = await api(`/api/conversations/${conversationId}`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    primaryDeleted = true;
    await waitFor('all conversation Kubernetes resources to be deleted', () =>
      !resourceExists('pod', podName)
      && !resourceExists('service', podName)
      && !resourceExists('pvc', pvcName)
      && !resourceExists('opencodeinstance', conversationId)
      && !resourceExists('conversationroute', conversationId), 90_000);
  });

  it('rolls back Pod, Service, and newly-created PVC after a failed image pull', async () => {
    const runtime = new KubernetesRuntime(
      new PortPool(42000, 42000, false),
      {
        image: 'invalid.invalid/agent-orchestrator/does-not-exist:e2e',
        namespace: K8S_NAMESPACE,
        podReadyTimeoutMs: 5_000,
        pvcStorage: '64Mi',
      },
    );

    await expect(runtime.start(
      failureId,
      '/unused',
      { username: 'e2e', password: 'e2e-password' },
      { retries: 1, intervalMs: 1, clientTimeoutMs: 1_000 },
    )).rejects.toThrow('not Ready in time');

    await waitFor('failed-start Kubernetes resource cleanup', () =>
      !resourceExists('pod', instanceObjectName(failureId))
      && !resourceExists('service', instanceObjectName(failureId))
      && !resourceExists('pvc', instanceVolumeClaimName(failureId)), 60_000);
  });

  it('serializes delete behind an in-flight start and leaves no Kubernetes resources', async () => {
    let response = await api('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ id: raceId }),
    });
    expect(response.status).toBe(201);

    const completionOrder: string[] = [];
    const startRequest = api(`/api/conversations/${raceId}/start`, {
      method: 'POST',
      body: '{}',
    }).then((result) => {
      completionOrder.push('start');
      return result;
    });

    await waitFor('in-flight start resources', () =>
      resourceExists('pod', instanceObjectName(raceId))
      && resourceExists('service', instanceObjectName(raceId))
      && resourceExists('pvc', instanceVolumeClaimName(raceId)), 30_000);

    const deleteRequest = api(`/api/conversations/${raceId}`, { method: 'DELETE' }).then((result) => {
      completionOrder.push('delete');
      return result;
    });

    const [startResponse, deleteResponse] = await Promise.all([startRequest, deleteRequest]);
    expect(startResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(204);
    expect(completionOrder).toEqual(['start', 'delete']);

    response = await api(`/api/conversations/${raceId}`);
    expect(response.status).toBe(404);
    await waitFor('start/delete race resource cleanup', () =>
      !resourceExists('pod', instanceObjectName(raceId))
      && !resourceExists('service', instanceObjectName(raceId))
      && !resourceExists('pvc', instanceVolumeClaimName(raceId))
      && !resourceExists('opencodeinstance', raceId)
      && !resourceExists('conversationroute', raceId), 90_000);
  });
});
