import { logger } from '../../utils/logger.js';
import { createObjectsClient, type StatusObjectsApi } from '../status-reporter.js';
import { planMigration, rankNodes, isRefillDue, refillWindowMs, type MigrationCandidate, type RefillPolicy } from './placement.js';
import { migrationsTotal } from '../../metrics/registry.js';
import { createLiveExecutor, createLiveVolumes, conversationVolumeBody, type Executor, type VolumeObjectsApi } from './executor.js';
import { conversationVolumeClaimName } from '../status-reporter.js';
import {
  CLEANUP_ARTIFACT_ANNOTATION,
  CLEANUP_OWNER_ANNOTATION,
  CLEANUP_STATE_ANNOTATION,
  CLEANUP_STATE_SINCE_ANNOTATION,
  DEFAULT_CLEANUP_OWNER,
  isPersistentDataArtifactId,
  isPersistentDataStateTimestamp,
} from '../../agent-runtime/runtimes/kubernetes.js';

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
  /** Stable owner annotation applied to operator-provisioned PVCs. */
  cleanupOwnerId?: string;
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
  cleanupOwnerId?: string;
}

export interface InstanceView {
  name: string;
  cleanupState?: string;
  cleanupOwnerId?: string;
  cleanupArtifactId?: string;
  cleanupStateSince?: string;
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
  const metadata = asRecord(obj.metadata);
  const annotations = asRecord(metadata.annotations);
  const spec = asRecord(obj.spec);
  const status = asRecord(obj.status);
  const model = asRecord(spec.model);
  return {
    name,
    ...(typeof annotations[CLEANUP_STATE_ANNOTATION] === 'string'
      ? { cleanupState: annotations[CLEANUP_STATE_ANNOTATION] as string }
      : {}),
    ...(typeof annotations[CLEANUP_OWNER_ANNOTATION] === 'string'
      ? { cleanupOwnerId: annotations[CLEANUP_OWNER_ANNOTATION] as string }
      : {}),
    ...(typeof annotations[CLEANUP_ARTIFACT_ANNOTATION] === 'string'
      ? { cleanupArtifactId: annotations[CLEANUP_ARTIFACT_ANNOTATION] as string }
      : {}),
    ...(typeof annotations[CLEANUP_STATE_SINCE_ANNOTATION] === 'string'
      ? { cleanupStateSince: annotations[CLEANUP_STATE_SINCE_ANNOTATION] as string }
      : {}),
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
    const activeInstances = instances.filter((instance) => instance.cleanupState !== 'delete-pending');
    const activeInstanceByName = new Map(activeInstances.map((instance) => [instance.name, instance]));

    await this.refillQuota(instances, summary);

    await this.createMissingRoutes(instances, routeByName, summary);

    // Keep established routes aligned with lifecycle changes. A stopped
    // instance must not remain routable, and a restarted/moved instance must
    // publish its refreshed endpoint before clients are sent to it.
    await this.synchronizeRoutes(instances, routeByName, summary);

    await this.deleteStaleRoutes(routes, activeInstanceByName, summary);

    // A delete-pending instance record is a durable tombstone, not placement
    // authority. Never recreate its route or PVC. Once UID-safe cleanup has
    // removed the claim, remove the corresponding CR as well.
    await this.retireDeletePendingInstances(instances, summary);

    await this.planMigrations(instances, activeInstances, routeByName, summary);

    return summary;
  }

  private async refillQuota(instances: InstanceView[], summary: ReconcileSummary): Promise<void> {
    const policy = this.options.refill ?? { defaultWindowMs: 24 * 60 * 60 * 1000 };
    const nowMs = Date.now();
    for (const instance of instances) {
      if (instance.cleanupState === 'delete-pending' || instance.phase !== 'QuotaExhausted') continue;
      if (!isRefillDue(instance.lastQuotaErrorAt, nowMs, refillWindowMs(policy, instance.model))) continue;
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
  }

  private async createMissingRoutes(
    instances: InstanceView[],
    routeByName: Map<string, RouteView>,
    summary: ReconcileSummary,
  ): Promise<void> {
    for (const instance of instances) {
      if (instance.cleanupState === 'delete-pending' || routeByName.has(instance.name)) continue;
      try {
        await this.ensureVolume(instance.name, summary);
        await this.api.createNamespacedCustomObject(
          GROUP, VERSION, this.options.namespace, ROUTES_PLURAL,
          {
            apiVersion: `${GROUP}/${VERSION}`,
            kind: 'ConversationRoute',
            metadata: { name: instance.name, labels: { 'app.kubernetes.io/part-of': 'agent-orchestrator' } },
            spec: { conversationId: instance.name },
          },
        );
        await this.setRouteStatus(instance.name, {
          phase: 'Active',
          currentInstanceRef: instance.name,
          ...(instance.endpoint ? { currentEndpoint: instance.endpoint } : {}),
          conditions: [{
            type: 'Routable', status: 'True', reason: 'InstanceActive',
            lastTransitionTime: new Date().toISOString(),
          }],
        });
        summary.routesCreated.push(instance.name);
        logger.info(`[operator] route created for ${instance.name}`);
      } catch (err) {
        summary.errors.push(`create route ${instance.name} failed: ${(err as Error).message}`);
      }
    }
  }

  private async synchronizeRoutes(
    instances: InstanceView[],
    routeByName: Map<string, RouteView>,
    summary: ReconcileSummary,
  ): Promise<void> {
    for (const instance of instances) {
      if (instance.cleanupState === 'delete-pending') continue;
      const route = routeByName.get(instance.name);
      if (!route) continue;
      try {
        if (instance.phase === 'Stopped' && route.phase !== 'Draining') {
          await this.setRouteStatus(instance.name, {
            phase: 'Draining',
            currentInstanceRef: instance.name,
            ...(instance.endpoint ? { currentEndpoint: instance.endpoint } : {}),
            conditions: [{
              type: 'Routable', status: 'False', reason: 'InstanceStopped',
              lastTransitionTime: new Date().toISOString(),
            }],
          });
        } else if (this.routeNeedsActivation(instance, route)) {
          await this.setRouteStatus(instance.name, {
            phase: 'Active',
            currentInstanceRef: instance.name,
            ...(instance.endpoint ? { currentEndpoint: instance.endpoint } : {}),
            conditions: [{
              type: 'Routable', status: 'True', reason: 'InstanceActive',
              lastTransitionTime: new Date().toISOString(),
            }],
          });
        }
      } catch (err) {
        summary.errors.push(`sync route ${instance.name} failed: ${(err as Error).message}`);
      }
    }
  }

  private routeNeedsActivation(instance: InstanceView, route: RouteView): boolean {
    return instance.phase === 'Ready' && (
      route.phase !== 'Active'
      || route.currentInstanceRef !== instance.name
      || route.currentEndpoint !== instance.endpoint
    );
  }

  private async deleteStaleRoutes(
    routes: RouteView[],
    activeInstanceByName: Map<string, InstanceView>,
    summary: ReconcileSummary,
  ): Promise<void> {
    for (const route of routes) {
      if (activeInstanceByName.has(route.name)) continue;
      try {
        await this.api.deleteNamespacedCustomObject(
          GROUP, VERSION, this.options.namespace, ROUTES_PLURAL, route.name,
        );
        summary.routesDeleted.push(route.name);
        logger.info(`[operator] route deleted for ${route.name} (instance unavailable)`);
      } catch (err) {
        summary.errors.push(`delete route ${route.name} failed: ${(err as Error).message}`);
      }
    }
  }

  private async retireDeletePendingInstances(
    instances: InstanceView[],
    summary: ReconcileSummary,
  ): Promise<void> {
    if (!this.volumes) return;
    for (const instance of instances) {
      if (instance.cleanupState !== 'delete-pending') continue;
      if (!this.canRetireDeletePendingInstance(instance)) {
        summary.errors.push(`delete-pending instance ${instance.name} has invalid cleanup ownership metadata`);
        continue;
      }
      try {
        await this.volumes.readPersistentVolumeClaim(
          this.options.namespace,
          conversationVolumeClaimName(instance.name),
        );
      } catch (err) {
        if (!isNotFoundLike(err)) {
          summary.errors.push(`read delete-pending volume ${instance.name} failed: ${(err as Error).message}`);
          continue;
        }
        await this.deleteRetiredInstanceRecord(instance.name, summary);
      }
    }
  }

  private async deleteRetiredInstanceRecord(name: string, summary: ReconcileSummary): Promise<void> {
    try {
      await this.api.deleteNamespacedCustomObject(
        GROUP, VERSION, this.options.namespace, INSTANCES_PLURAL, name,
      );
      logger.info(`[operator] delete-pending instance record removed for ${name}`);
    } catch (err) {
      if (!isNotFoundLike(err)) {
        summary.errors.push(`delete pending instance ${name} failed: ${(err as Error).message}`);
      }
    }
  }

  private async planMigrations(
    instances: InstanceView[],
    activeInstances: InstanceView[],
    routeByName: Map<string, RouteView>,
    summary: ReconcileSummary,
  ): Promise<void> {
    for (const instance of instances) {
      if (instance.cleanupState === 'delete-pending' || instance.phase !== 'QuotaExhausted') continue;
      const route = routeByName.get(instance.name);
      if (!route || route.phase !== 'Active' || route.desiredInstanceRef) continue;
      if (!this.options.dryRun) {
        await this.executeMigration(instance, summary, loadByNode(activeInstances));
        continue;
      }
      const candidates = this.migrationCandidates(instance, instances);
      const decision = planMigration(
        {
          name: instance.name,
          ...(instance.nodeName ? { nodeName: instance.nodeName } : {}),
          ...(instance.model ? { model: instance.model } : {}),
        },
        candidates,
        loadByNode(activeInstances),
      );
      summary.migrationsPlanned.push({
        from: instance.name,
        ...(decision.action === 'migrate' ? { target: decision.target } : {}),
        reason: decision.reason,
      });
      const outcome = decision.action === 'migrate'
        ? `would migrate ${instance.name} -> ${decision.target}`
        : `no migration target for ${instance.name}`;
      logger.info(`[operator] ${decision.action === 'migrate' ? '[dry-run] ' : ''}${outcome} (${decision.reason})`);
    }
  }

  private migrationCandidates(instance: InstanceView, instances: InstanceView[]): MigrationCandidate[] {
    return instances
      .filter(candidate => candidate.name !== instance.name && candidate.cleanupState !== 'delete-pending')
      .map(candidate => ({
        name: candidate.name,
        ...(candidate.nodeName ? { nodeName: candidate.nodeName } : {}),
        ...(candidate.model ? { model: candidate.model } : {}),
        phase: candidate.phase ?? 'Unknown',
      }));
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
      const existing = await this.volumes.readPersistentVolumeClaim(this.options.namespace, claim);
      if (!isManagedConversationVolume(existing, claim, conversationId)) {
        throw new Error(`refusing to use unmanaged persistent volume claim ${claim}`);
      }
    } catch (err) {
      if (!isNotFoundLike(err)) throw err;
      await this.volumes.createPersistentVolumeClaim(
        this.options.namespace,
        conversationVolumeBody(
          conversationId,
          this.options.pvcStorage ?? '10Gi',
          this.options.cleanupOwnerId,
        ),
      );
      summary.volumesProvisioned.push(claim);
      logger.info(`[operator] volume provisioned for ${conversationId}`);
    }
  }

  private canRetireDeletePendingInstance(instance: InstanceView): boolean {
    return instance.cleanupOwnerId === (this.options.cleanupOwnerId ?? DEFAULT_CLEANUP_OWNER)
      && isPersistentDataArtifactId(instance.cleanupArtifactId)
      && isPersistentDataStateTimestamp(instance.cleanupStateSince);
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
      ...(options?.cleanupOwnerId ? { cleanupOwnerId: options.cleanupOwnerId } : {}),
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

function isManagedConversationVolume(value: unknown, expectedName: string, conversationId: string): boolean {
  const body = asRecord(value);
  const metadata = asRecord(body.metadata);
  const labels = asRecord(metadata.labels);
  return metadata.name === expectedName
    && labels['app.kubernetes.io/part-of'] === 'agent-orchestrator'
    && labels['agentorchestrator.io/conversation'] === conversationId;
}
