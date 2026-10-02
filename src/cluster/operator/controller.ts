import { logger } from '../../utils/logger.js';
import { createObjectsClient, type StatusObjectsApi } from '../status-reporter.js';
import { planMigration, rankNodes, isRefillDue, refillWindowMs, type MigrationCandidate, type RefillPolicy } from './placement.js';
import { migrationsTotal } from '../../metrics/registry.js';
import { createLiveExecutor, createLiveVolumes, conversationVolumeBody, type Executor, type VolumeObjectsApi } from './executor.js';
import { conversationVolumeClaimName } from '../status-reporter.js';

const GROUP = 'agentorchestrator.io';
const VERSION = 'v1alpha1';
const INSTANCES_PLURAL = 'opencodeinstances';
const ROUTES_PLURAL = 'conversationroutes';

export interface ControllerOptions {
  namespace: string;
  /** Reconcile interval in ms. */
  intervalMs: number;
  /**
   * Dry-run mode: migration decisions are logged, never written.
   * Execute mode (!dryRun) performs route flips + migrate calls.
   */
  dryRun: boolean;
  /** Time-based quota refill policy. Default 24h for all models. */
  refill?: RefillPolicy;
  /** Storage request for auto-provisioned per-conversation PVCs. Default '10Gi'. */
  pvcStorage?: string;
}

export interface RunOperatorOptions {
  namespace?: string;
  intervalMs?: number;
  execute?: boolean;
  apiKey?: string;
  migrateTimeoutMs?: number;
  refill?: RefillPolicy;
  metricsPort?: number;
  pvcStorage?: string;
}

export interface InstanceView {
  name: string;
  nodeName?: string;
  model?: { providerID: string; id: string };
  endpoint?: string;
  phase?: string;
  reportedBy?: string;
  lastQuotaErrorAt?: string;
}

export interface MigrationHistoryEntry {
  from: string;
  to: string;
  reason: string;
  at: string;
}

export interface RouteView {
  name: string;
  phase?: string;
  currentInstanceRef?: string;
  currentEndpoint?: string;
  desiredInstanceRef?: string;
  migrationHistory?: MigrationHistoryEntry[];
}

export interface PlannedMigration {
  from: string;
  target?: string;
  reason: string;
}

export interface ReconcileSummary {
  routesCreated: string[];
  routesDeleted: string[];
  migrationsPlanned: PlannedMigration[];
  refillsCompleted: string[];
  volumesProvisioned: string[];
  volumesDeleted: string[];
  errors: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function isNotFoundLike(err: unknown): boolean {
  const e = err as {
    statusCode?: unknown;
    code?: unknown;
    status?: unknown;
    response?: { httpStatusCode?: unknown };
  };
  for (const candidate of [e?.statusCode, e?.response?.httpStatusCode, e?.code, e?.status]) {
    if (candidate === 404) return true;
  }
  return false;
}

function toInstanceView(name: string, body: unknown): InstanceView {
  const obj = asRecord(body);
  const spec = asRecord(obj.spec);
  const status = asRecord(obj.status);
  const model = asRecord(spec.model);
  return {
    name,
    ...(typeof spec.nodeName === 'string' ? { nodeName: spec.nodeName } : {}),
    ...(typeof model.providerID === 'string' && typeof model.id === 'string'
      ? { model: { providerID: model.providerID, id: model.id } }
      : {}),
    ...(typeof spec.endpoint === 'string' ? { endpoint: spec.endpoint } : {}),
    ...(typeof status.phase === 'string' ? { phase: status.phase } : {}),
    ...(typeof status.reportedBy === 'string' ? { reportedBy: status.reportedBy } : {}),
    ...(typeof asRecord(status.lastQuotaError).at === 'string'
      ? { lastQuotaErrorAt: asRecord(status.lastQuotaError).at as string }
      : {}),
  };
}

function toRouteView(name: string, body: unknown): RouteView {
  const obj = asRecord(body);
  const spec = asRecord(obj.spec);
  const status = asRecord(obj.status);
  const history = Array.isArray(status.migrationHistory)
    ? (status.migrationHistory as unknown[]).flatMap((entry) => {
        const rec = asRecord(entry);
        return typeof rec.from === 'string' && typeof rec.to === 'string' && typeof rec.reason === 'string' && typeof rec.at === 'string'
          ? [{ from: rec.from, to: rec.to, reason: rec.reason, at: rec.at }]
          : [];
      })
    : undefined;
  return {
    name,
    ...(typeof status.phase === 'string' ? { phase: status.phase } : {}),
    ...(typeof status.currentInstanceRef === 'string' ? { currentInstanceRef: status.currentInstanceRef } : {}),
    ...(typeof status.currentEndpoint === 'string' ? { currentEndpoint: status.currentEndpoint } : {}),
    ...(typeof spec.desiredInstanceRef === 'string' ? { desiredInstanceRef: spec.desiredInstanceRef } : {}),
    ...(history ? { migrationHistory: history } : {}),
  };
}

export class PlacementController {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly api: StatusObjectsApi,
    private readonly options: ControllerOptions,
    private readonly executor?: Executor,
    private readonly volumes?: VolumeObjectsApi,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.reconcileOnce();
    this.timer = setInterval(() => {
      void this.reconcileOnce();
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One reconcile pass: refill, route lifecycle, migration planning/execution. Never throws. */
  async reconcileOnce(): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { routesCreated: [], routesDeleted: [], migrationsPlanned: [], refillsCompleted: [], volumesProvisioned: [], volumesDeleted: [], errors: [] };
    const { namespace } = this.options;
    let instances: InstanceView[];
    let routes: RouteView[];
    try {
      const [instanceList, routeList] = await Promise.all([
        this.api.listNamespacedCustomObject(GROUP, VERSION, namespace, INSTANCES_PLURAL),
        this.api.listNamespacedCustomObject(GROUP, VERSION, namespace, ROUTES_PLURAL),
      ]);
      instances = itemsOf(instanceList).map(([name, body]) => toInstanceView(name, body));
      routes = itemsOf(routeList).map(([name, body]) => toRouteView(name, body));
    } catch (err) {
      summary.errors.push(`list failed: ${(err as Error).message}`);
      return summary;
    }

    const routeByName = new Map(routes.map((r) => [r.name, r]));
    const instanceByName = new Map(instances.map((i) => [i.name, i]));

    // Time-based refill first: quota windows that elapsed clear back to Ready
    // so later passes (and the planner) see recovered capacity.
    const refillPolicy = this.options.refill ?? { defaultWindowMs: 24 * 60 * 60 * 1000 };
    const nowMs = Date.now();
    for (const instance of instances) {
      if (instance.phase !== 'QuotaExhausted') continue;
      if (!isRefillDue(instance.lastQuotaErrorAt, nowMs, refillWindowMs(refillPolicy, instance.model))) continue;
      try {
        await this.setInstanceStatus(instance.name, {
          phase: 'Ready',
          reachable: true,
          consecutiveFailures: 0,
          lastHeartbeat: new Date(nowMs).toISOString(),
        });
        instance.phase = 'Ready';
        summary.refillsCompleted.push(instance.name);
        logger.info(`[operator] quota refilled for ${instance.name}, back to Ready`);
      } catch (err) {
        summary.errors.push(`refill ${instance.name} failed: ${(err as Error).message}`);
      }
    }

    for (const instance of instances) {
      if (routeByName.has(instance.name)) continue;
      try {
        await this.ensureVolume(instance.name, summary);
        await this.api.createNamespacedCustomObject(GROUP, VERSION, namespace, ROUTES_PLURAL, {
          apiVersion: `${GROUP}/${VERSION}`,
          kind: 'ConversationRoute',
          metadata: { name: instance.name, labels: { 'app.kubernetes.io/part-of': 'agent-orchestrator' } },
          spec: { conversationId: instance.name },
        });
        await this.setRouteStatus(instance.name, {
          phase: 'Active',
          ...(instance.name ? { currentInstanceRef: instance.name } : {}),
          ...(instance.endpoint ? { currentEndpoint: instance.endpoint } : {}),
          conditions: [{ type: 'Routable', status: 'True', reason: 'InstanceActive', lastTransitionTime: new Date().toISOString() }],
        });
        summary.routesCreated.push(instance.name);
        logger.info(`[operator] route created for ${instance.name}`);
      } catch (err) {
        summary.errors.push(`create route ${instance.name} failed: ${(err as Error).message}`);
      }
    }

    for (const route of routes) {
      if (instanceByName.has(route.name)) continue;
      // The instance object is gone only on explicit conversation DELETE
      // (stop keeps a Stopped object), so its volume goes with it.
      try {
        await this.deleteVolume(route.name, summary);
        await this.api.deleteNamespacedCustomObject(GROUP, VERSION, namespace, ROUTES_PLURAL, route.name);
        summary.routesDeleted.push(route.name);
        logger.info(`[operator] route deleted for ${route.name} (instance gone)`);
      } catch (err) {
        summary.errors.push(`delete route ${route.name} failed: ${(err as Error).message}`);
      }
    }

    for (const instance of instances) {
      if (instance.phase !== 'QuotaExhausted') continue;
      const route = routeByName.get(instance.name);
      if (!route || route.phase !== 'Active' || route.desiredInstanceRef) continue;
      if (!this.options.dryRun) {
        await this.executeMigration(instance, summary, loadByNode(instances));
        continue;
      }
      const candidates: MigrationCandidate[] = instances
        .filter((c) => c.name !== instance.name)
        .map((c) => ({ name: c.name, ...(c.nodeName ? { nodeName: c.nodeName } : {}), ...(c.model ? { model: c.model } : {}), phase: c.phase ?? 'Unknown' }));
      const decision = planMigration(
        {
          name: instance.name,
          ...(instance.nodeName ? { nodeName: instance.nodeName } : {}),
          ...(instance.model ? { model: instance.model } : {}),
        },
        candidates,
        loadByNode(instances),
      );
      if (decision.action === 'migrate') {
        summary.migrationsPlanned.push({ from: instance.name, target: decision.target, reason: decision.reason });
        logger.info(`[operator] [dry-run] would migrate ${instance.name} -> ${decision.target} (${decision.reason})`);
      } else {
        summary.migrationsPlanned.push({ from: instance.name, reason: decision.reason });
        logger.info(`[operator] no migration target for ${instance.name} (${decision.reason})`);
      }
    }

    return summary;
  }

  /**
   * Execute a quota migration: flip the route to Migrating, call the owning
   * orchestrator's migrate endpoint on a healthy node, then flip back to
   * Active with history. Failures leave the route Migrating with a reason so
   * the next pass skips it (no migrate storms); recovery is manual or via
   * refill (Phase F).
   */
  private async executeMigration(instance: InstanceView, summary: ReconcileSummary, load: Map<string, number>): Promise<void> {
    const name = instance.name;
    const { namespace } = this.options;
    if (!this.executor) {
      summary.errors.push(`execute mode needs an executor (nodes+migrate clients)`);
      return;
    }
    if (!instance.reportedBy) {
      summary.errors.push(`no reportedBy owner for ${name}, cannot trigger migration`);
      return;
    }
    let nodes: string[];
    try {
      nodes = await this.executor.nodes.listReadyNodeNames(instance.nodeName);
    } catch (err) {
      summary.errors.push(`node listing failed: ${(err as Error).message}`);
      return;
    }
    if (nodes.length === 0) {
      summary.migrationsPlanned.push({ from: name, reason: 'no healthy target node' });
      migrationsTotal.labels('no_target').inc();
      logger.info(`[operator] no healthy target node for ${name}, waiting`);
      return;
    }
    const targetNode = rankNodes(nodes, load)[0];
    const at = (ms: number): string => new Date(ms).toISOString();
    try {
      await this.setRouteStatus(name, {
        phase: 'Migrating',
        conditions: [{ type: 'Routable', status: 'False', reason: 'MigrationInProgress', message: `moving to ${targetNode}`, lastTransitionTime: at(Date.now()) }],
      });
      const result = await this.executor.migrate.callMigrate(instance.reportedBy, name, targetNode);
      const refreshed = await this.api.getNamespacedCustomObject(GROUP, VERSION, namespace, INSTANCES_PLURAL, name);
      const refreshedSpec = asRecord((refreshed.body as Record<string, unknown>).spec);
      await this.setRouteStatus(name, {
        phase: 'Active',
        currentInstanceRef: name,
        ...(typeof refreshedSpec.endpoint === 'string' ? { currentEndpoint: refreshedSpec.endpoint } : {}),
        conditions: [{ type: 'Routable', status: 'True', reason: 'MigrationCompleted', message: `moved to ${targetNode}, resumed=${result.resumed}`, lastTransitionTime: at(Date.now()) }],
        migrationHistory: [
          ...(await this.currentHistory(name)),
          {
            from: name,
            to: name,
            reason: `QuotaExhausted(${instance.nodeName ?? '?'}->${targetNode})`,
            at: at(Date.now()),
          },
        ],
      });
      summary.migrationsPlanned.push({ from: name, target: targetNode, reason: `migrated, resumed=${result.resumed}` });
      migrationsTotal.labels('completed').inc();
      logger.info(`[operator] migrated ${name} -> ${targetNode} (resumed=${result.resumed})`);
    } catch (err) {
      try {
        await this.setRouteStatus(name, {
          phase: 'Migrating',
          conditions: [{ type: 'Routable', status: 'False', reason: 'MigrationFailed', message: (err as Error).message, lastTransitionTime: at(Date.now()) }],
        });
      } catch {
        // Best effort; the error below already records the failure.
      }
      migrationsTotal.labels('failed').inc();
      summary.errors.push(`migration of ${name} failed: ${(err as Error).message}`);
    }
  }

  private async currentHistory(name: string): Promise<MigrationHistoryEntry[]> {
    try {
      const existing = await this.api.getNamespacedCustomObject(GROUP, VERSION, this.options.namespace, ROUTES_PLURAL, name);
      const status = asRecord(((existing.body ?? {}) as Record<string, unknown>).status);
      if (!Array.isArray(status.migrationHistory)) return [];
      return (status.migrationHistory as unknown[]).flatMap((entry) => {
        const rec = asRecord(entry);
        return typeof rec.from === 'string' && typeof rec.to === 'string' && typeof rec.reason === 'string' && typeof rec.at === 'string'
          ? [{ from: rec.from, to: rec.to, reason: rec.reason, at: rec.at }]
          : [];
      });
    } catch {
      return [];
    }
  }

  private async ensureVolume(conversationId: string, summary: ReconcileSummary): Promise<void> {
    if (!this.volumes) return;
    const claim = conversationVolumeClaimName(conversationId);
    try {
      await this.volumes.readPersistentVolumeClaim(this.options.namespace, claim);
    } catch (err) {
      if (!isNotFoundLike(err)) throw err;
      await this.volumes.createPersistentVolumeClaim(
        this.options.namespace,
        conversationVolumeBody(conversationId, this.options.pvcStorage ?? '10Gi'),
      );
      summary.volumesProvisioned.push(claim);
      logger.info(`[operator] volume provisioned for ${conversationId}`);
    }
  }

  private async deleteVolume(conversationId: string, summary: ReconcileSummary): Promise<void> {
    if (!this.volumes) return;
    const claim = conversationVolumeClaimName(conversationId);
    try {
      await this.volumes.deletePersistentVolumeClaim(this.options.namespace, claim);
      summary.volumesDeleted.push(claim);
      logger.info(`[operator] volume deleted for ${conversationId}`);
    } catch (err) {
      if (!isNotFoundLike(err)) throw err;
    }
  }

  private async setInstanceStatus(name: string, status: Record<string, unknown>): Promise<void> {
    const existing = await this.api.getNamespacedCustomObject(GROUP, VERSION, this.options.namespace, INSTANCES_PLURAL, name);
    const current = (existing.body ?? {}) as Record<string, unknown>;
    const currentStatus = asRecord(current.status);
    await this.api.replaceNamespacedCustomObjectStatus(GROUP, VERSION, this.options.namespace, INSTANCES_PLURAL, name, {
      ...current,
      status: { ...currentStatus, ...status },
    });
  }

  private async setRouteStatus(name: string, status: Record<string, unknown>): Promise<void> {
    const existing = await this.api.getNamespacedCustomObject(GROUP, VERSION, this.options.namespace, ROUTES_PLURAL, name);
    const current = (existing.body ?? {}) as Record<string, unknown>;
    const currentStatus = asRecord(current.status);
    await this.api.replaceNamespacedCustomObjectStatus(GROUP, VERSION, this.options.namespace, ROUTES_PLURAL, name, {
      ...current,
      status: { ...currentStatus, ...status },
    });
  }
}

function loadByNode(instances: InstanceView[]): Map<string, number> {
  const load = new Map<string, number>();
  for (const instance of instances) {
    if (!instance.nodeName) continue;
    load.set(instance.nodeName, (load.get(instance.nodeName) ?? 0) + 1);
  }
  return load;
}

function itemsOf(list: { body: object }): Array<[string, unknown]> {
  const body = asRecord((list as { body?: unknown }).body ?? list);
  const items = Array.isArray(body.items) ? body.items : [];
  return items.map((item) => {
    const metadata = asRecord((item as Record<string, unknown>).metadata);
    return [typeof metadata.name === 'string' ? metadata.name : '', item] as [string, unknown];
  });
}

/**
 * Build a controller from the default kubeconfig chain and run it until
 * `stop()` is called. Resolves with the stop function once the first
 * reconcile pass completes.
 */
export async function runOperator(options?: RunOperatorOptions): Promise<() => void> {
  const namespace = options?.namespace ?? 'ao-instances';
  const execute = options?.execute ?? false;
  const controller = new PlacementController(
    createObjectsClient(),
    {
      namespace,
      intervalMs: options?.intervalMs ?? 15000,
      dryRun: !execute,
      ...(options?.refill ? { refill: options.refill } : {}),
      ...(options?.pvcStorage ? { pvcStorage: options.pvcStorage } : {}),
    },
    execute
      ? createLiveExecutor({ ...(options?.apiKey ? { apiKey: options.apiKey } : {}), ...(options?.migrateTimeoutMs ? { timeoutMs: options.migrateTimeoutMs } : {}) })
      : undefined,
    createLiveVolumes(),
  );
  let stopMetrics: (() => void) | undefined;
  if (options?.metricsPort) {
    const { startMetricsServer } = await import('./metrics-server.js');
    const server = await startMetricsServer(options.metricsPort);
    stopMetrics = () => server.close();
  }
  controller.start();
  return () => {
    controller.stop();
    stopMetrics?.();
  };
}
