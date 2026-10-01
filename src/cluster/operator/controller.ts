import { logger } from '../../utils/logger.js';
import { createObjectsClient, type StatusObjectsApi } from '../status-reporter.js';
import { planMigration, type MigrationCandidate } from './placement.js';

const GROUP = 'agentorchestrator.io';
const VERSION = 'v1alpha1';
const INSTANCES_PLURAL = 'opencodeinstances';
const ROUTES_PLURAL = 'conversationroutes';

export interface ControllerOptions {
  namespace: string;
  /** Reconcile interval in ms. */
  intervalMs: number;
  /**
   * Dry-run mode (E1): migration decisions are logged, never written.
   * Execution (route phase flips) arrives with Phase E2.
   */
  dryRun: boolean;
}

export interface InstanceView {
  name: string;
  nodeName?: string;
  model?: { providerID: string; id: string };
  endpoint?: string;
  phase?: string;
}

export interface RouteView {
  name: string;
  phase?: string;
  currentInstanceRef?: string;
  desiredInstanceRef?: string;
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
  };
}

function toRouteView(name: string, body: unknown): RouteView {
  const obj = asRecord(body);
  const spec = asRecord(obj.spec);
  const status = asRecord(obj.status);
  return {
    name,
    ...(typeof status.phase === 'string' ? { phase: status.phase } : {}),
    ...(typeof status.currentInstanceRef === 'string' ? { currentInstanceRef: status.currentInstanceRef } : {}),
    ...(typeof spec.desiredInstanceRef === 'string' ? { desiredInstanceRef: spec.desiredInstanceRef } : {}),
  };
}

export class PlacementController {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly api: StatusObjectsApi,
    private readonly options: ControllerOptions,
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
    const { namespace, dryRun } = this.options;
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
        logger.info(`[operator]${dryRun ? ' [dry-run]' : ''} would migrate ${instance.name} -> ${decision.target} (${decision.reason})`);
      } else {
        summary.migrationsPlanned.push({ from: instance.name, reason: decision.reason });
        logger.info(`[operator] no migration target for ${instance.name} (${decision.reason})`);
      }
    }

    return summary;
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
export async function runOperator(options?: Partial<ControllerOptions>): Promise<() => void> {
  const namespace = options?.namespace ?? 'ao-instances';
  const controller = new PlacementController(createObjectsClient(), {
    namespace,
    intervalMs: options?.intervalMs ?? 15000,
    dryRun: options?.dryRun ?? true,
  });
  controller.start();
  return () => controller.stop();
}
