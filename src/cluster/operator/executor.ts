import * as k8s from '@kubernetes/client-node';
// Deep import: the promise-flavored API is not re-exported from the package
// root in client-node v1.x. Pin to ^1.x where this path is stable.
import { PromiseCoreV1Api } from '@kubernetes/client-node/dist/gen/types/PromiseAPI.js';
import { logger } from '../../utils/logger.js';
import { conversationVolumeClaimName } from '../status-reporter.js';

/** Minimal node inventory surface (structurally compatible). */
export interface CoreNodesApi {
  listNode(): Promise<unknown>;
}

export interface NodeInventory {
  listReadyNodeNames(excludeNode?: string): Promise<string[]>;
}

export interface MigrateResult {
  resumed: boolean;
  sessionId?: string;
  nodeName: string;
}

export interface MigrateCaller {
  callMigrate(ownerBaseUrl: string, conversationId: string, nodeName: string): Promise<MigrateResult>;
}

function nodeRecords(list: unknown): Array<{ name?: string; ready?: boolean }> {
  const items = ((list ?? {}) as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const rec = (item ?? {}) as {
      metadata?: { name?: string };
      status?: { conditions?: Array<{ type?: string; status?: string }> };
    };
    return {
      ...(typeof rec.metadata?.name === 'string' ? { name: rec.metadata.name } : {}),
      ready: (rec.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
    };
  });
}

export class K8sNodeInventory implements NodeInventory {
  constructor(private readonly api: CoreNodesApi) {}

  async listReadyNodeNames(excludeNode?: string): Promise<string[]> {
    const names = nodeRecords(await this.api.listNode())
      .filter((n) => n.ready && typeof n.name === 'string' && n.name !== excludeNode)
      .map((n) => n.name as string)
      .sort();
    return names;
  }
}

export function createMigrateCaller(options?: {
  apiKey?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): MigrateCaller {
  const timeoutMs = options?.timeoutMs ?? 300000;
  const fetchFn = options?.fetchFn ?? fetch;
  return {
    async callMigrate(ownerBaseUrl: string, conversationId: string, nodeName: string): Promise<MigrateResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`migrate call timed out after ${timeoutMs}ms`)), timeoutMs);
      try {
        const res = await fetchFn(
          `${ownerBaseUrl.replace(/\/$/, '')}/api/conversations/${encodeURIComponent(conversationId)}/migrate`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(options?.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
            },
            body: JSON.stringify({ nodeName }),
            signal: controller.signal,
          },
        );
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          const detail = (body.error as { message?: string } | undefined)?.message ?? res.statusText;
          throw new Error(`migrate call failed: HTTP ${res.status}: ${detail}`);
        }
        return {
          resumed: body.resumed === true,
          ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
          ...(typeof body.nodeName === 'string' ? { nodeName: body.nodeName } : { nodeName }),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createCoreApi(): PromiseCoreV1Api {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const cluster = kc.getCurrentCluster();
  if (!cluster?.server) {
    throw new Error('No active cluster in kubeconfig');
  }
  const configuration = k8s.createConfiguration({
    baseServer: new k8s.ServerConfiguration(cluster.server, {}),
    authMethods: { default: kc },
  });
  return new PromiseCoreV1Api(configuration);
}

export interface Executor {
  nodes: NodeInventory;
  migrate: MigrateCaller;
}

/** Build a live executor from the default kubeconfig chain. Throws when unavailable. */
export function createLiveExecutor(options?: { apiKey?: string; timeoutMs?: number }): Executor {
  return {
    nodes: new K8sNodeInventory(createCoreApi()),
    migrate: createMigrateCaller({ ...(options ?? {}) }),
  };
}

/** Build a live volume client from the default kubeconfig chain. Throws when unavailable. */
export function createLiveVolumes(): VolumeObjectsApi {
  return new K8sVolumeObjects(createCoreApi());
}

/** Minimal PVC surface for per-conversation volume lifecycle (structurally compatible). */
export interface VolumeObjectsApi {
  readPersistentVolumeClaim(namespace: string, name: string): Promise<unknown>;
  createPersistentVolumeClaim(namespace: string, body: object): Promise<unknown>;
  deletePersistentVolumeClaim(namespace: string, name: string): Promise<void>;
}

export class K8sVolumeObjects implements VolumeObjectsApi {
  constructor(private readonly api: PromiseCoreV1Api) {}

  async readPersistentVolumeClaim(namespace: string, name: string): Promise<unknown> {
    return this.api.readNamespacedPersistentVolumeClaim(name, namespace);
  }

  async createPersistentVolumeClaim(namespace: string, body: object): Promise<unknown> {
    return this.api.createNamespacedPersistentVolumeClaim(namespace, body);
  }

  async deletePersistentVolumeClaim(namespace: string, name: string): Promise<void> {
    await this.api.deleteNamespacedPersistentVolumeClaim(name, namespace);
  }
}

/** PVC body for a conversation volume (RWO, default provisioner). */
export function conversationVolumeBody(conversationId: string, storage: string): object {
  const claim = conversationVolumeClaimName(conversationId);
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: {
      name: claim,
      labels: { 'app.kubernetes.io/part-of': 'agent-orchestrator', 'agentorchestrator.io/conversation': conversationId },
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage } },
    },
  };
}

export function logExecutorError(context: string, err: unknown): void {
  logger.warn(`[operator] ${context}: ${(err as Error).message}`);
}
