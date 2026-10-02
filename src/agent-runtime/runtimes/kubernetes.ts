import { logger } from '../../utils/logger.js';
import { OpenCodeAgentClient } from '../../opencode-http/client.js';
import { PortPool } from '../../orchestrator/port-pool.js';
import { waitForHealthy } from '../health.js';
import { conversationMountPath, sanitizeSessionId, sessionPodEnv } from '../session-storage.js';
import type { AgentRuntime, AgentCapabilities, AgentEndpoint, InstanceHandle, HealthCheckConfig, RuntimeAccess } from '../types.js';
import type { KubernetesRuntimeConfig } from '../../config-loader.js';
// Deep import: the promise-flavored API is not re-exported from the package
// root in client-node v1.x. Pin to ^1.x where this path is stable.
import { PromiseCoreV1Api } from '@kubernetes/client-node/dist/gen/types/PromiseAPI.js';
import * as k8s from '@kubernetes/client-node';

export interface PodStatusView {
  phase?: string;
  ready?: boolean;
  podIP?: string;
  message?: string;
}

/** Opt-in node placement for runtimes (migration targets). */
export interface NodePlaceable {
  setNodeOverride(id: string, nodeName: string): void;
  clearNodeOverride(id: string): void;
}

/** Narrow pod/service surface used by the runtime (structurally compatible). */
export interface InstancePodsApi {
  createPod(namespace: string, body: object): Promise<unknown>;
  readPod(namespace: string, name: string): Promise<PodStatusView>;
  deletePod(namespace: string, name: string, opts?: { force?: boolean }): Promise<void>;
  createService(namespace: string, body: object): Promise<unknown>;
  deleteService(namespace: string, name: string): Promise<void>;
  listInstancePodNames(namespace: string): Promise<string[]>;
}

const PART_OF_LABEL = 'app.kubernetes.io/part-of';
const PART_OF_VALUE = 'agent-orchestrator';
const CONVERSATION_LABEL = 'agentorchestrator.io/conversation';
const INSTANCE_POD_SELECTOR = `${PART_OF_LABEL}=${PART_OF_VALUE},${CONVERSATION_LABEL}`;
const DEFAULT_NAMESPACE = 'ao-instances';
const DEFAULT_POD_READY_TIMEOUT_MS = 180000;
const EXIT_POLL_INTERVAL_MS = 2000;

/** DNS-1123-safe object name fragment for a conversation id. */
export function sanitizeK8sName(id: string): string {
  const clean = sanitizeSessionId(id).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  return clean.slice(0, 200) || 'conv';
}

/** Stable per-instance Pod/Service name. Service DNS stays constant across restarts. */
export function instanceObjectName(id: string): string {
  return `opencode-${sanitizeK8sName(id)}`;
}

/** Per-conversation PVC name (matches the plan's `conv-<id>` convention). */
export function instanceVolumeClaimName(id: string): string {
  return `conv-${sanitizeK8sName(id)}`;
}

export function instancePodLabelSelector(): string {
  return INSTANCE_POD_SELECTOR;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delete a Pod and wait until it is gone. Tries graceful termination first
 * (clean SQLite checkpoint on the PVC), then force-deletes so callers never
 * observe a Terminating pod on recreate.
 */
async function deletePodAndWait(api: InstancePodsApi, namespace: string, podName: string, timeoutMs = 60000): Promise<void> {
  try {
    await api.deletePod(namespace, podName);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    return;
  }
  const half = Math.floor(timeoutMs / 2);
  try {
    await waitForPodGone(api, namespace, podName, half);
    return;
  } catch {
    await api.deletePod(namespace, podName, { force: true }).catch((err: unknown) => {
      if (!isNotFound(err)) throw err;
    });
    await waitForPodGone(api, namespace, podName, half);
  }
}

async function waitForPodGone(api: InstancePodsApi, namespace: string, podName: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await api.readPod(namespace, podName);
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Instance Pod ${podName} did not terminate in time`);
    }
    await sleep(1000);
  }
}

class K8sPodHandle implements InstanceHandle {
  private _exitCode: number | null = null;
  private exited = false;
  private readonly callbacks: Array<(code: number | null) => void> = [];

  constructor(
    private readonly api: InstancePodsApi,
    private readonly namespace: string,
    private readonly podName: string,
    private readonly serviceName: string,
  ) {}

  get pid(): number | undefined {
    return undefined;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  async kill(): Promise<void> {
    await this.deleteIgnoringNotFound(() => this.api.deleteService(this.namespace, this.serviceName));
    await deletePodAndWait(this.api, this.namespace, this.podName);
    this.finish(null);
  }

  async waitForExit(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exited) return;
      try {
        await this.api.readPod(this.namespace, this.podName);
      } catch (err) {
        if (isNotFound(err)) {
          this.finish(null);
          return;
        }
      }
      await sleep(Math.min(EXIT_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
  }

  onExit(callback: (code: number | null) => void): void {
    if (this.exited) {
      callback(this._exitCode);
      return;
    }
    this.callbacks.push(callback);
    void this.pollUntilGone();
  }

  private async pollUntilGone(): Promise<void> {
    for (;;) {
      try {
        const status = await this.api.readPod(this.namespace, this.podName);
        if (status.phase === 'Succeeded' || status.phase === 'Failed') {
          this.finish(null);
          return;
        }
      } catch (err) {
        if (isNotFound(err)) {
          this.finish(null);
          return;
        }
      }
      await sleep(EXIT_POLL_INTERVAL_MS);
    }
  }

  private async waitForGone(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.api.readPod(this.namespace, this.podName);
      } catch (err) {
        if (isNotFound(err)) return;
        throw err;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Instance Pod ${this.podName} did not terminate in time`);
      }
      await sleep(1000);
    }
  }

  private finish(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this._exitCode = code;
    for (const cb of this.callbacks.splice(0)) {
      try {
        cb(code);
      } catch {
        // Listener errors must not break lifecycle handling.
      }
    }
  }

  private async deleteIgnoringNotFound(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

export class KubernetesRuntime implements AgentRuntime, NodePlaceable {
  readonly type = 'kubernetes';
  readonly capabilities: AgentCapabilities = {
    sessions: true,
    streaming: true,
    files: true,
    tools: true,
    config: true,
    agents: true,
    skills: true,
  };

  private portPool: PortPool;
  private config: KubernetesRuntimeConfig;
  private podsApi?: InstancePodsApi;
  private nodeOverrides = new Map<string, string>();
  private instanceState = new Map<string, {
    podName: string;
    serviceName: string;
    port: number;
    auth: { username: string; password: string };
  }>();

  constructor(portPool: PortPool, config: KubernetesRuntimeConfig, podsApi?: InstancePodsApi) {
    this.portPool = portPool;
    this.config = config;
    this.podsApi = podsApi;
  }

  private namespace(): string {
    return this.config.namespace ?? DEFAULT_NAMESPACE;
  }

  /** Pin the next start/restart of `id` to a node. Cleared explicitly. */
  setNodeOverride(id: string, nodeName: string): void {
    this.nodeOverrides.set(id, nodeName);
  }

  clearNodeOverride(id: string): void {
    this.nodeOverrides.delete(id);
  }

  private nodeFor(id: string): string | undefined {
    return this.nodeOverrides.get(id) ?? this.config.nodeName;
  }

  private podReadyTimeoutMs(): number {
    return this.config.podReadyTimeoutMs ?? DEFAULT_POD_READY_TIMEOUT_MS;
  }

  private api(): InstancePodsApi {
    if (!this.podsApi) {
      this.podsApi = createLivePodsApi();
    }
    return this.podsApi;
  }

  async start(
    id: string,
    workspacePath: string,
    auth: { username: string; password: string },
    healthCheckConfig: HealthCheckConfig,
    _runtimeAccess?: RuntimeAccess,
  ): Promise<AgentEndpoint> {
    void workspacePath;
    const port = await this.portPool.allocate();
    if (port === null) {
      throw new Error('No available ports in pool');
    }

    const podName = instanceObjectName(id);
    const serviceName = podName;
    const namespace = this.namespace();
    const mountRoot = conversationMountPath(id);
    const sessionEnv = sessionPodEnv(id, this.config.sessionMode ?? 'xdg');

    // Service DNS is stable across restarts; the serve port comes from the pool.
    const baseUrl = `http://${this.config.instanceHost ?? `${serviceName}.${namespace}.svc.cluster.local`}:${port}`;
    const client = new OpenCodeAgentClient(baseUrl, auth.username, auth.password);

    try {
      logger.info(`Creating OpenCode instance Pod ${podName} on port ${port} (image: ${this.config.image})`);
      await this.api().createService(namespace, {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: serviceName,
          labels: { [PART_OF_LABEL]: PART_OF_VALUE, [CONVERSATION_LABEL]: sanitizeK8sName(id) },
        },
        spec: {
          type: 'ClusterIP',
          selector: { [CONVERSATION_LABEL]: sanitizeK8sName(id) },
          ports: [{ name: 'server', port, targetPort: port }],
        },
      });
      await this.api().createPod(namespace, this.podBody(id, podName, port, mountRoot, sessionEnv, auth));

      await this.waitForPodReady(namespace, podName);
      await waitForHealthy(id, baseUrl, auth, healthCheckConfig);

      const handle = new K8sPodHandle(this.api(), namespace, podName, serviceName);
      this.instanceState.set(id, { podName, serviceName, port, auth });
      return { client, port, handle, baseUrl };
    } catch (err) {
      this.portPool.release(port);
      throw err;
    }
  }

  async restart(id: string, healthCheckConfig: HealthCheckConfig): Promise<AgentEndpoint> {
    const state = this.instanceState.get(id);
    if (!state) {
      throw new Error(`No stored state for instance ${id}`);
    }

    logger.info(`Restarting OpenCode instance Pod ${state.podName}...`);
    const namespace = this.namespace();
    const api = this.api();

    // Delete Pod and Service, then recreate with a fresh port. The Service DNS
    // name stays constant, so baseUrl host is stable; sessions resume from the
    // PVC (same claim, untouched). Pod deletion is asynchronous — wait until
    // the object is gone, otherwise create hits AlreadyExists ("terminating").
    await deletePodAndWait(api, namespace, state.podName);
    await this.deleteIgnoringNotFound(() => api.deleteService(namespace, state.serviceName));
    this.instanceState.delete(id);

    const port = await this.portPool.allocate();
    if (port === null) {
      throw new Error('No available ports in pool');
    }

    const mountRoot = conversationMountPath(id);
    const sessionEnv = sessionPodEnv(id, this.config.sessionMode ?? 'xdg');
    const baseUrl = `http://${this.config.instanceHost ?? `${state.serviceName}.${namespace}.svc.cluster.local`}:${port}`;
    const client = new OpenCodeAgentClient(baseUrl, state.auth.username, state.auth.password);

    try {
      await api.createService(namespace, {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: {
          name: state.serviceName,
          labels: { [PART_OF_LABEL]: PART_OF_VALUE, [CONVERSATION_LABEL]: sanitizeK8sName(id) },
        },
        spec: {
          type: 'ClusterIP',
          selector: { [CONVERSATION_LABEL]: sanitizeK8sName(id) },
          ports: [{ name: 'server', port, targetPort: port }],
        },
      });
      await api.createPod(namespace, this.podBody(id, state.podName, port, mountRoot, sessionEnv, state.auth));

      await this.waitForPodReady(namespace, state.podName);
      await waitForHealthy(id, baseUrl, state.auth, healthCheckConfig);

      const handle = new K8sPodHandle(api, namespace, state.podName, state.serviceName);
      this.instanceState.set(id, { podName: state.podName, serviceName: state.serviceName, port, auth: state.auth });
      return { client, port, handle, baseUrl };
    } catch (err) {
      this.portPool.release(port);
      throw err;
    }
  }

  async stop(handle?: InstanceHandle): Promise<void> {
    if (handle) {
      await handle.kill();
    }
  }

  async cleanupOrphans(): Promise<void> {
    const namespace = this.namespace();
    const names = await this.api().listInstancePodNames(namespace);
    for (const podName of names) {
      logger.warn(`Removing orphan instance Pod ${podName}`);
      await this.deleteIgnoringNotFound(() => this.api().deletePod(namespace, podName));
      await this.deleteIgnoringNotFound(() => this.api().deleteService(namespace, podName));
    }
  }

  private podBody(
    id: string,
    podName: string,
    port: number,
    mountRoot: string,
    sessionEnv: Record<string, string>,
    auth: { username: string; password: string },
  ): object {
    const env = [
      { name: 'OPENCODE_SERVER_USERNAME', value: auth.username },
      { name: 'OPENCODE_SERVER_PASSWORD', value: auth.password },
      ...Object.entries(sessionEnv).map(([name, value]) => ({ name, value })),
    ];
    // Kubelet probes must authenticate: the server requires Basic auth.
    const probeAuthHeader = {
      name: 'Authorization',
      value: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`,
    };
    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: podName,
        labels: { [PART_OF_LABEL]: PART_OF_VALUE, [CONVERSATION_LABEL]: sanitizeK8sName(id) },
      },
      spec: {
        restartPolicy: 'Never',
        securityContext: { fsGroup: 1001 },
        ...(this.nodeFor(id) ? { nodeName: this.nodeFor(id) } : {}),
        containers: [
          {
            name: 'opencode',
            image: this.config.image,
            ports: [{ name: 'server', containerPort: port }],
            env,
            args: ['serve', '--port', String(port), '--hostname', '0.0.0.0'],
            workingDir: `${mountRoot}/workspace`,
            volumeMounts: [{ name: 'conversation-data', mountPath: mountRoot }],
            ...(this.config.resources ? { resources: this.config.resources } : {}),
            livenessProbe: { httpGet: { path: '/global/health', port, httpHeaders: [probeAuthHeader] }, initialDelaySeconds: 10, periodSeconds: 30 },
            readinessProbe: { httpGet: { path: '/global/health', port, httpHeaders: [probeAuthHeader] }, initialDelaySeconds: 5, periodSeconds: 10 },
          },
        ],
        volumes: [{ name: 'conversation-data', persistentVolumeClaim: { claimName: instanceVolumeClaimName(id) } }],
      },
    };
  }

  private async waitForPodReady(namespace: string, podName: string): Promise<void> {
    const deadline = Date.now() + this.podReadyTimeoutMs();
    for (;;) {
      let status: PodStatusView;
      try {
        status = await this.api().readPod(namespace, podName);
      } catch (err) {
        if (!isNotFound(err)) throw err;
        status = {};
      }
      if (status.ready) return;
      if (status.phase === 'Failed' || status.phase === 'Unknown') {
        throw new Error(`Instance Pod ${podName} entered phase ${status.phase}${status.message ? `: ${status.message}` : ''}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Instance Pod ${podName} not Ready in time (check the conv-<id> PVC exists and the image pulls cleanly)`,
        );
      }
      await sleep(1000);
    }
  }

  private async deleteIgnoringNotFound(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
}

class LivePodsApi implements InstancePodsApi {
  constructor(private readonly api: PromiseCoreV1Api, private readonly labelSelector = INSTANCE_POD_SELECTOR) {}

  async createPod(namespace: string, body: object): Promise<unknown> {
    return this.api.createNamespacedPod(namespace, body);
  }

  async readPod(namespace: string, name: string): Promise<PodStatusView> {
    const pod = (await this.api.readNamespacedPod(name, namespace)) as {
      status?: { phase?: string; podIP?: string; message?: string; conditions?: Array<{ type?: string; status?: string }> };
    };
    const status = pod.status ?? {};
    return {
      ...(status.phase ? { phase: status.phase } : {}),
      ...(status.podIP ? { podIP: status.podIP } : {}),
      ...(status.message ? { message: status.message } : {}),
      ready: (status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
    };
  }

  async deletePod(namespace: string, name: string, opts?: { force?: boolean }): Promise<void> {
    await this.api.deleteNamespacedPod(name, namespace, undefined, undefined, opts?.force ? 0 : undefined);
  }

  async createService(namespace: string, body: object): Promise<unknown> {
    return this.api.createNamespacedService(namespace, body);
  }

  async deleteService(namespace: string, name: string): Promise<void> {
    await this.api.deleteNamespacedService(name, namespace);
  }

  async listInstancePodNames(namespace: string): Promise<string[]> {
    const list = (await this.api.listNamespacedPod(
      namespace,
      undefined, undefined, undefined, undefined,
      this.labelSelector,
    )) as { items?: Array<{ metadata?: { name?: string } }> };
    return (list.items ?? []).map((item) => item.metadata?.name ?? '').filter(Boolean);
  }
}

function createLivePodsApi(): InstancePodsApi {
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();
  const cluster = kc.getCurrentCluster();
  if (!cluster?.server) {
    throw new Error('No active cluster in kubeconfig: cannot use the kubernetes runtime outside a cluster context');
  }
  const configuration = k8s.createConfiguration({
    baseServer: new k8s.ServerConfiguration(cluster.server, {}),
    authMethods: { default: kc },
  });
  return new LivePodsApi(new PromiseCoreV1Api(configuration));
}
