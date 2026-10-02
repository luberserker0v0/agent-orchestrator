import { logger } from '../../utils/logger.js';
import { createObjectsClient, type StatusObjectsApi } from '../status-reporter.js';
import { planMigration, type MigrationCandidate } from './placement.js';
import { createLiveExecutor, type Executor } from './executor.js';

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
}

export interface RunOperatorOptions {
  namespace?: string;
  intervalMs?: number;
  execute?: boolean;
  apiKey?: string;
  migrateTimeoutMs?: number;
}

export interface InstanceView {
  name: string;
  nodeName?: string;
  model?: { providerID: string; id: string };
  endpoint?: string;
  phase?: string;
  reportedBy?: string;
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
  errors: string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
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

  /** One reconcile pass: route lifecycle + dry-run migration planning. Never throws. */
  async reconcileOnce(): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { routesCreated: [], routesDeleted: [], migrationsPlanned: [], errors: [] };
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

    for (const instance of instances) {
      if (routeByName.has(instance.name)) continue;
      try {
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
      try {
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
        await this.executeMigration(instance, summary);
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
  private async executeMigration(instance: InstanceView, summary: ReconcileSummary): Promise<void> {
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
      logger.info(`[operator] no healthy target node for ${name}, waiting`);
      return;
    }
    const targetNode = nodes[0];
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
    },
    execute
      ? createLiveExecutor({ ...(options?.apiKey ? { apiKey: options.apiKey } : {}), ...(options?.migrateTimeoutMs ? { timeoutMs: options.migrateTimeoutMs } : {}) })
      : undefined,
  );
  controller.start();
  return () => controller.stop();
}
