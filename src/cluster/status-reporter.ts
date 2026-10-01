import { hostname } from 'node:os';
import * as k8s from '@kubernetes/client-node';
// Deep import: the promise-flavored API is not re-exported from the package
// root in client-node v1.x. Pin to ^1.x where this path is stable.
import { PromiseCustomObjectsApi } from '@kubernetes/client-node/dist/gen/types/PromiseAPI.js';
import { logger } from '../utils/logger.js';
import { ErrorCodes } from '../utils/errors.js';
import type { ClusterConfig } from '../config-loader.js';

const GROUP = 'agentorchestrator.io';
const VERSION = 'v1alpha1';
const INSTANCES_PLURAL = 'opencodeinstances';

export interface StatusReporterConfig {
  enabled: boolean;
  namespace: string;
  heartbeatIntervalMs: number;
  quotaFailureThreshold: number;
}

/** Minimal surface of CustomObjectsApi used by the reporter (structurally compatible). */
export interface StatusObjectsApi {
  createNamespacedCustomObject(
    group: string,
    version: string,
    namespace: string,
    plural: string,
    body: object,
  ): Promise<{ body: object }>;
  getNamespacedCustomObject(
    group: string,
    version: string,
    namespace: string,
    plural: string,
    name: string,
  ): Promise<{ body: { status?: Record<string, unknown> } }>;
  replaceNamespacedCustomObject(
    group: string,
    version: string,
    namespace: string,
    plural: string,
    name: string,
    body: object,
  ): Promise<{ body: object }>;
  replaceNamespacedCustomObjectStatus(
    group: string,
    version: string,
    namespace: string,
    plural: string,
    name: string,
    body: object,
  ): Promise<{ body: object }>;
  deleteNamespacedCustomObject(
    group: string,
    version: string,
    namespace: string,
    plural: string,
    name: string,
  ): Promise<{ body: object }>;
  listNamespacedCustomObject(
    group: string,
    version: string,
    namespace: string,
    plural: string,
  ): Promise<{ body: object }>;
}

export interface TrackInstanceInfo {
  conversationId: string;
  runtimeType?: string;
  endpoint?: string;
  volumeClaimName?: string;
  model?: { providerID: string; id: string };
}

export interface QuotaErrorReport {
  code: string;
  message: string;
  retryAfterMs?: number;
  model?: { providerID: string; id: string };
}

interface TrackedState {
  info: TrackInstanceInfo;
  consecutiveQuotaFailures: number;
  lastPhase: string;
}

/** Naming convention for per-conversation volumes (plan §5). */
export function conversationVolumeClaimName(conversationId: string): string {
  return `conv-${conversationId}`;
}

/** Node/machine identifier: downward-API NODE_NAME when present, else OS hostname. */
export function currentNodeName(): string {
  return process.env.NODE_NAME ?? hostname();
}

function httpStatusOf(err: unknown): number | undefined {
  const e = err as {
    statusCode?: unknown;
    code?: unknown;
    status?: unknown;
    response?: { httpStatusCode?: unknown };
  };
  for (const candidate of [e?.statusCode, e?.response?.httpStatusCode, e?.code, e?.status]) {
    if (typeof candidate === 'number') return candidate;
  }
  return undefined;
}

function isNotFound(err: unknown): boolean {
  return httpStatusOf(err) === 404;
}

function isConflict(err: unknown): boolean {
  return httpStatusOf(err) === 409;
}

/** Adapt the promise-flavored client to the reporter's narrow interface. */
class PromiseObjectsAdapter implements StatusObjectsApi {
  constructor(private readonly api: PromiseCustomObjectsApi) {}

  async createNamespacedCustomObject(group: string, version: string, namespace: string, plural: string, body: object): Promise<{ body: object }> {
    return { body: (await this.api.createNamespacedCustomObject(group, version, namespace, plural, body)) as object };
  }

  async getNamespacedCustomObject(group: string, version: string, namespace: string, plural: string, name: string): Promise<{ body: { status?: Record<string, unknown> } }> {
    const body = (await this.api.getNamespacedCustomObject(group, version, namespace, plural, name)) as { status?: Record<string, unknown> };
    return { body };
  }

  async replaceNamespacedCustomObject(group: string, version: string, namespace: string, plural: string, name: string, body: object): Promise<{ body: object }> {
    return { body: (await this.api.replaceNamespacedCustomObject(group, version, namespace, plural, name, body)) as object };
  }

  async replaceNamespacedCustomObjectStatus(group: string, version: string, namespace: string, plural: string, name: string, body: object): Promise<{ body: object }> {
    return { body: (await this.api.replaceNamespacedCustomObjectStatus(group, version, namespace, plural, name, body)) as object };
  }

  async deleteNamespacedCustomObject(group: string, version: string, namespace: string, plural: string, name: string): Promise<{ body: object }> {
    return { body: (await this.api.deleteNamespacedCustomObject(group, version, namespace, plural, name)) as object };
  }

  async listNamespacedCustomObject(group: string, version: string, namespace: string, plural: string): Promise<{ body: object }> {
    return { body: (await this.api.listNamespacedCustomObject(group, version, namespace, plural)) as object };
  }
}

/** Build a live objects client from the default kubeconfig chain. Throws when unavailable. */
export function createObjectsClient(): StatusObjectsApi {
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
  return new PromiseObjectsAdapter(new PromiseCustomObjectsApi(configuration));
}

export function resolveReporterConfig(config?: ClusterConfig): StatusReporterConfig {
  return {
    enabled: config?.enabled ?? false,
    namespace: config?.namespace ?? 'ao-instances',
    heartbeatIntervalMs: config?.heartbeatIntervalMs ?? 60000,
    quotaFailureThreshold: config?.quotaFailureThreshold ?? 2,
  };
}

/**
 * Reports OpencodeInstance lifecycle to Kubernetes. All methods are safe to
 * call unconditionally: when disabled or unreachable they log once and no-op,
 * never throwing into the request path. Callers must not await the returned
 * promises on hot paths.
 */
export class K8sStatusReporter {
  private readonly api?: StatusObjectsApi;
  private readonly namespace: string;
  private readonly threshold: number;
  private readonly tracked = new Map<string, TrackedState>();
  private heartbeatTimer?: NodeJS.Timeout;
  private warned = false;

  constructor(api: StatusObjectsApi | undefined, config: StatusReporterConfig) {
    this.api = api;
    this.namespace = config.namespace;
    this.threshold = config.quotaFailureThreshold;
    if (api && config.heartbeatIntervalMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        void this.heartbeatAll();
      }, config.heartbeatIntervalMs);
      this.heartbeatTimer.unref?.();
    }
  }

  /**
   * Build a reporter from cluster config. Returns a disabled reporter (with a
   * warning) when reporting is off, no kubeconfig is available, or the CRDs
   * are not installed — the orchestrator keeps serving either way.
   */
  static async create(config?: ClusterConfig): Promise<K8sStatusReporter> {
    const resolved = resolveReporterConfig(config);
    if (!resolved.enabled) {
      return new K8sStatusReporter(undefined, resolved);
    }
    try {
      const api = createObjectsClient();
      // Fail fast when the CRDs are missing so the operator notices at startup.
      await api.listNamespacedCustomObject(GROUP, VERSION, resolved.namespace, INSTANCES_PLURAL);
      logger.info(`Instance status reporting enabled (namespace: ${resolved.namespace})`);
      return new K8sStatusReporter(api, resolved);
    } catch (err) {
      logger.warn(`Instance status reporting disabled: ${(err as Error).message}`);
      return new K8sStatusReporter(undefined, resolved);
    }
  }

  isEnabled(): boolean {
    return this.api !== undefined;
  }

  trackedCount(): number {
    return this.tracked.size;
  }

  /** Create (or adopt on 409) the OpencodeInstance object for a conversation. */
  async trackInstance(info: TrackInstanceInfo): Promise<void> {
    if (!this.api) return;
    const name = info.conversationId;
    try {
      await this.api.createNamespacedCustomObject(GROUP, VERSION, this.namespace, INSTANCES_PLURAL, {
        apiVersion: `${GROUP}/${VERSION}`,
        kind: 'OpencodeInstance',
        metadata: { name, labels: { 'app.kubernetes.io/part-of': 'agent-orchestrator' } },
        spec: {
          conversationId: info.conversationId,
          nodeName: currentNodeName(),
          ...(info.runtimeType ? { runtime: info.runtimeType } : {}),
          endpoint: info.endpoint ?? '',
          ...(info.model ? { model: info.model } : {}),
          volumeClaimName: info.volumeClaimName ?? conversationVolumeClaimName(name),
        },
      });
      this.tracked.set(name, { info, consecutiveQuotaFailures: 0, lastPhase: 'Ready' });
      await this.patchStatus(name, { phase: 'Ready', reachable: true, lastHeartbeat: new Date().toISOString() });
    } catch (err) {
      if (isConflict(err)) {
        await this.adoptExisting(name, info);
        return;
      }
      this.warnOnce(`trackInstance(${name}) failed: ${(err as Error).message}`);
    }
  }

  /** Record a classified LLM quota/rate-limit failure with flap-guard Compose. */
  async reportQuotaError(conversationId: string, report: QuotaErrorReport): Promise<void> {
    if (!this.api) return;
    if (!this.tracked.has(conversationId)) {
      await this.trackInstance({ conversationId, ...(report.model ? { model: report.model } : {}) });
    }
    const tracked = this.tracked.get(conversationId);
    if (!tracked) return;
    const failures = tracked.consecutiveQuotaFailures + 1;
    const exhausting = report.code === ErrorCodes.LLM_QUOTA_EXHAUSTED;
    const phase = exhausting && failures >= this.threshold ? 'QuotaExhausted' : exhausting ? 'Ready' : 'RateLimited';
    try {
      if (report.model && report.model.providerID !== tracked.info.model?.providerID) {
        await this.patchSpecModel(conversationId, report.model);
        tracked.info = { ...tracked.info, model: report.model };
      }
      await this.patchStatus(conversationId, {
        phase,
        reachable: phase !== 'QuotaExhausted',
        lastHeartbeat: new Date().toISOString(),
        lastQuotaError: { code: 429, message: report.message, at: new Date().toISOString() },
        consecutiveFailures: failures,
      });
      tracked.consecutiveQuotaFailures = failures;
      tracked.lastPhase = phase;
    } catch (err) {
      this.warnOnce(`reportQuotaError(${conversationId}) failed: ${(err as Error).message}`);
    }
  }

  /** Record a successful send: reset flap counter, flip back to Ready if needed. */
  async reportSuccess(conversationId: string): Promise<void> {
    if (!this.api) return;
    if (!this.tracked.has(conversationId)) {
      await this.trackInstance({ conversationId });
    }
    const tracked = this.tracked.get(conversationId);
    if (!tracked) return;
    tracked.consecutiveQuotaFailures = 0;
    if (tracked.lastPhase === 'Ready') return;
    try {
      await this.patchStatus(conversationId, {
        phase: 'Ready',
        reachable: true,
        lastHeartbeat: new Date().toISOString(),
        consecutiveFailures: 0,
      });
      tracked.lastPhase = 'Ready';
    } catch (err) {
      this.warnOnce(`reportSuccess(${conversationId}) failed: ${(err as Error).message}`);
    }
  }

  /** Refresh the reported endpoint after a move (e.g. migration allocated a new port). */
  async reportMoved(conversationId: string, update: { endpoint: string }): Promise<void> {
    if (!this.api) return;
    try {
      const existing = await this.api.getNamespacedCustomObject(GROUP, VERSION, this.namespace, INSTANCES_PLURAL, conversationId);
      const current = (existing.body ?? {}) as Record<string, unknown>;
      const spec = (current.spec && typeof current.spec === 'object' ? (current.spec as Record<string, unknown>) : {});
      await this.api.replaceNamespacedCustomObject(GROUP, VERSION, this.namespace, INSTANCES_PLURAL, conversationId, {
        ...current,
        spec: { ...spec, endpoint: update.endpoint },
        status: { ...((current.status ?? {}) as Record<string, unknown>), lastHeartbeat: new Date().toISOString() },
      });
    } catch (err) {
      this.warnOnce(`reportMoved(${conversationId}) failed: ${(err as Error).message}`);
    }
  }

  /** Delete the object (404-tolerant). Called on conversation stop/delete. */
  async untrackInstance(conversationId: string): Promise<void> {
    if (!this.api) return;
    this.tracked.delete(conversationId);
    try {
      await this.api.deleteNamespacedCustomObject(GROUP, VERSION, this.namespace, INSTANCES_PLURAL, conversationId);
    } catch (err) {
      if (!isNotFound(err)) {
        this.warnOnce(`untrackInstance(${conversationId}) failed: ${(err as Error).message}`);
      }
    }
  }

  destroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.tracked.clear();
  }

  private async adoptExisting(name: string, info: TrackInstanceInfo): Promise<void> {
    try {
      const existing = await this.api!.getNamespacedCustomObject(GROUP, VERSION, this.namespace, INSTANCES_PLURAL, name);
      const status = existing.body.status ?? {};
      this.tracked.set(name, {
        info,
        consecutiveQuotaFailures: typeof status.consecutiveFailures === 'number' ? status.consecutiveFailures : 0,
        lastPhase: typeof status.phase === 'string' ? status.phase : 'Ready',
      });
      await this.patchStatus(name, { phase: 'Ready', reachable: true, lastHeartbeat: new Date().toISOString() });
    } catch (err) {
      this.warnOnce(`adoptExisting(${name}) failed: ${(err as Error).message}`);
    }
  }

  private async patchStatus(name: string, status: Record<string, unknown>): Promise<void> {
    const existing = await this.api!.getNamespacedCustomObject(GROUP, VERSION, this.namespace, INSTANCES_PLURAL, name);
    const current = (existing.body ?? {}) as Record<string, unknown>;
    const merged = {
      ...(current.status && typeof current.status === 'object' ? (current.status as Record<string, unknown>) : {}),
      ...status,
    };
    await this.api!.replaceNamespacedCustomObjectStatus(GROUP, VERSION, this.namespace, INSTANCES_PLURAL, name, {
      ...current,
      status: merged,
    });
  }

  private async patchSpecModel(name: string, model: { providerID: string; id: string }): Promise<void> {
    const existing = await this.api!.getNamespacedCustomObject(GROUP, VERSION, this.namespace, INSTANCES_PLURAL, name);
    const current = (existing.body ?? {}) as Record<string, unknown>;
    const spec = (current.spec && typeof current.spec === 'object' ? (current.spec as Record<string, unknown>) : {});
    await this.api!.replaceNamespacedCustomObject(GROUP, VERSION, this.namespace, INSTANCES_PLURAL, name, {
      ...current,
      spec: { ...spec, model },
    });
  }

  private async heartbeatAll(): Promise<void> {
    if (!this.api) return;
    const now = new Date().toISOString();
    for (const name of this.tracked.keys()) {
      try {
        await this.patchStatus(name, { lastHeartbeat: now });
      } catch (err) {
        this.warnOnce(`heartbeat(${name}) failed: ${(err as Error).message}`);
      }
    }
  }

  private warnOnce(message: string): void {
    if (!this.warned) {
      this.warned = true;
      logger.warn(message);
    }
  }
}
