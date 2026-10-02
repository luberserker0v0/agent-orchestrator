import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PlacementController, type ReconcileSummary } from './controller.js';
import type { StatusObjectsApi } from '../status-reporter.js';

const MODEL = { providerID: 'anthropic', id: 'claude-sonnet-4' };

function instanceBody(overrides: Record<string, unknown> = {}): object {
  return {
    metadata: { name: 'x' },
    spec: { conversationId: 'x', endpoint: 'http://x:1', volumeClaimName: 'conv-x', ...((overrides.spec ?? {}) as object) },
    status: { phase: 'Ready', ...(overrides.status ?? {}) },
  };
}

function routeBody(overrides: Record<string, unknown> = {}): object {
  return {
    metadata: { name: 'x' },
    spec: { conversationId: 'x', ...((overrides.spec ?? {}) as object) },
    status: { phase: 'Active', ...((overrides.status ?? {}) as object) },
  };
}

function createFake(stores: { instances: Map<string, object>; routes: Map<string, object> }): StatusObjectsApi & { calls: string[] } {
  const calls: string[] = [];
  const storeFor = (plural: string) => (plural === 'opencodeinstances' ? stores.instances : stores.routes);
  return {
    calls,
    createNamespacedCustomObject: vi.fn(async (_g: string, _v: string, _ns: string, plural: string, body: object) => {
      calls.push(`create:${plural}`);
      const name = ((body as { metadata: { name: string } }).metadata.name);
      storeFor(plural).set(name, body);
      return { body };
    }),
    getNamespacedCustomObject: vi.fn(async (_g: string, _v: string, _ns: string, plural: string, name: string) => {
      const found = storeFor(plural).get(name);
      if (!found) {
        const err = new Error('not found') as Error & { statusCode: number };
        err.statusCode = 404;
        throw err;
      }
      return { body: found };
    }),
    replaceNamespacedCustomObject: vi.fn(async () => ({ body: {} })),
    replaceNamespacedCustomObjectStatus: vi.fn(async (_g: string, _v: string, _ns: string, plural: string, name: string, body: object) => {
      calls.push(`replaceStatus:${plural}:${name}`);
      storeFor(plural).set(name, body);
      return { body };
    }),
    deleteNamespacedCustomObject: vi.fn(async (_g: string, _v: string, _ns: string, plural: string, name: string) => {
      calls.push(`delete:${plural}:${name}`);
      storeFor(plural).delete(name);
      return { body: {} };
    }),
    listNamespacedCustomObject: vi.fn(async (_g: string, _v: string, _ns: string, plural: string) => {
      const items = [...storeFor(plural).entries()].map(([name, body]) => ({
        ...((body ?? {}) as object),
        metadata: { name },
      }));
      return { body: { items } };
    }),
  } as unknown as StatusObjectsApi & { calls: string[] };
}

function controllerWith(stores: { instances: Map<string, object>; routes: Map<string, object> }): {
  controller: PlacementController;
  api: StatusObjectsApi & { calls: string[] };
} {
  const api = createFake(stores);
  const controller = new PlacementController(api, { namespace: 'ao-instances', intervalMs: 0, dryRun: true });
  return { controller, api };
}

describe('PlacementController', () => {
  let stores: { instances: Map<string, object>; routes: Map<string, object> };

  beforeEach(() => {
    stores = { instances: new Map(), routes: new Map() };
  });

  it('creates Active routes for instances without one', async () => {
    stores.instances.set('a', instanceBody());
    const { controller } = controllerWith(stores);
    const summary: ReconcileSummary = await controller.reconcileOnce();
    expect(summary.routesCreated).toEqual(['a']);
    expect(summary.errors).toEqual([]);
    expect(stores.routes.has('a')).toBe(true);
  });

  it('deletes routes whose instance is gone', async () => {
    stores.routes.set('ghost', routeBody());
    const { controller } = controllerWith(stores);
    const summary = await controller.reconcileOnce();
    expect(summary.routesDeleted).toEqual(['ghost']);
    expect(stores.routes.has('ghost')).toBe(false);
  });

  it('plans migration for QuotaExhausted instances in dry-run without writing', async () => {
    stores.instances.set('a', instanceBody({ spec: { nodeName: 'n1', model: MODEL }, status: { phase: 'QuotaExhausted' } }));
    stores.instances.set('b', instanceBody({ spec: { nodeName: 'n2', model: MODEL }, status: { phase: 'Ready' } }));
    stores.routes.set('a', routeBody({ status: { phase: 'Active', currentInstanceRef: 'a' } }));
    stores.routes.set('b', routeBody({ status: { phase: 'Active', currentInstanceRef: 'b' } }));
    const { controller, api } = controllerWith(stores);
    const summary = await controller.reconcileOnce();
    expect(summary.migrationsPlanned).toEqual([
      { from: 'a', target: 'b', reason: expect.stringContaining('n1 -> n2') },
    ]);
    expect(api.calls.filter((c) => c.startsWith('replaceStatus'))).toHaveLength(0);
  });

  it('records no-target outcomes', async () => {
    stores.instances.set('a', instanceBody({ spec: { nodeName: 'n1', model: MODEL }, status: { phase: 'QuotaExhausted' } }));
    stores.routes.set('a', routeBody({ status: { phase: 'Active', currentInstanceRef: 'a' } }));
    const { controller } = controllerWith(stores);
    const summary = await controller.reconcileOnce();
    expect(summary.migrationsPlanned).toEqual([{ from: 'a', reason: expect.any(String) }]);
  });

  it('skips planning when route is not Active', async () => {
    stores.instances.set('a', instanceBody({ status: { phase: 'QuotaExhausted' } }));
    stores.routes.set('a', routeBody({ status: { phase: 'Migrating', currentInstanceRef: 'a' } }));
    const { controller } = controllerWith(stores);
    const summary = await controller.reconcileOnce();
    expect(summary.migrationsPlanned).toEqual([]);
  });

  it('never throws on list failures', async () => {
    const broken = {
      listNamespacedCustomObject: vi.fn(async () => {
        throw new Error('down');
      }),
    } as unknown as StatusObjectsApi;
    const summary = await new PlacementController(broken, {
      namespace: 'ao-instances',
      intervalMs: 0,
      dryRun: true,
    }).reconcileOnce();
    expect(summary.errors).toHaveLength(1);
  });

  describe('execute mode', () => {
    function apiFor(current: { instances: Map<string, object>; routes: Map<string, object> }): StatusObjectsApi & { calls: string[] } {
      return controllerWith(current).api;
    }

    it('migrates via the owner and flips the route Active with history', async () => {
      stores.instances.set('a', {
        ...instanceBody(),
        metadata: { name: 'a' },
        spec: { conversationId: 'a', nodeName: 'n1', endpoint: 'http://old:1', model: MODEL, volumeClaimName: 'conv-a' },
        status: { phase: 'QuotaExhausted', reportedBy: 'http://owner:8080' },
      });
      stores.routes.set('a', {
        ...routeBody(),
        metadata: { name: 'a' },
        status: { phase: 'Active', currentInstanceRef: 'a' },
      });
      const nodes = { listReadyNodeNames: vi.fn(async () => ['n2']) };
      const migrate = { callMigrate: vi.fn(async () => ({ resumed: true, sessionId: 's1', nodeName: 'n2' })) };
      const api = apiFor(stores);
      const controller = new PlacementController(api, { namespace: 'ao-instances', intervalMs: 0, dryRun: false }, { nodes, migrate });

      const summary = await controller.reconcileOnce();

      expect(migrate.callMigrate).toHaveBeenCalledWith('http://owner:8080', 'a', 'n2');
      expect(summary.migrationsPlanned).toEqual([{ from: 'a', target: 'n2', reason: expect.stringContaining('resumed=true') }]);
      expect(summary.errors).toEqual([]);
      const route = stores.routes.get('a') as { status: Record<string, unknown> };
      expect(route.status.phase).toBe('Active');
      expect(route.status.currentInstanceRef).toBe('a');
      const history = route.status.migrationHistory as Array<{ from: string; to: string; reason: string }>;
      expect(history).toHaveLength(1);
      expect(history[0].from).toBe('a');
      expect(history[0].reason).toContain('n1->n2');
    });

    it('records an error when reportedBy is missing', async () => {
      stores.instances.set('a', instanceBody({ status: { phase: 'QuotaExhausted' } }));
      stores.routes.set('a', routeBody({ status: { phase: 'Active', currentInstanceRef: 'a' } }));
      const api = apiFor(stores);
      const controller = new PlacementController(
        api,
        { namespace: 'ao-instances', intervalMs: 0, dryRun: false },
        { nodes: { listReadyNodeNames: vi.fn(async () => ['n2']) }, migrate: { callMigrate: vi.fn() } },
      );

      const summary = await controller.reconcileOnce();

      expect(summary.errors).toEqual([expect.stringContaining('reportedBy')]);
    });

    it('leaves the route Migrating with a reason when the migrate call fails', async () => {
      stores.instances.set('a', {
        ...instanceBody(),
        metadata: { name: 'a' },
        spec: { nodeName: 'n1' },
        status: { phase: 'QuotaExhausted', reportedBy: 'http://owner:8080' },
      });
      stores.routes.set('a', routeBody({ status: { phase: 'Active', currentInstanceRef: 'a' } }));
      const api = apiFor(stores);
      const migrate = { callMigrate: vi.fn(async () => { throw new Error('owner down'); }) };
      const controller = new PlacementController(
        api,
        { namespace: 'ao-instances', intervalMs: 0, dryRun: false },
        { nodes: { listReadyNodeNames: vi.fn(async () => ['n2']) }, migrate },
      );

      const summary = await controller.reconcileOnce();

      expect(summary.errors).toEqual([expect.stringContaining('migration of a failed')]);
      const route = stores.routes.get('a') as { status: Record<string, unknown> };
      expect(route.status.phase).toBe('Migrating');
      const conditions = route.status.conditions as Array<{ reason: string }>;
      expect(conditions[0].reason).toBe('MigrationFailed');
    });

    it('waits without writes when no target node exists', async () => {
      stores.instances.set('a', {
        ...instanceBody(),
        metadata: { name: 'a' },
        spec: { nodeName: 'n1' },
        status: { phase: 'QuotaExhausted', reportedBy: 'http://owner:8080' },
      });
      stores.routes.set('a', routeBody({ status: { phase: 'Active', currentInstanceRef: 'a' } }));
      const api = apiFor(stores);
      const migrate = { callMigrate: vi.fn() };
      const controller = new PlacementController(
        api,
        { namespace: 'ao-instances', intervalMs: 0, dryRun: false },
        { nodes: { listReadyNodeNames: vi.fn(async () => []) }, migrate },
      );

      const summary = await controller.reconcileOnce();

      expect(migrate.callMigrate).not.toHaveBeenCalled();
      expect(summary.migrationsPlanned).toEqual([{ from: 'a', reason: 'no healthy target node' }]);
      const route = stores.routes.get('a') as { status: Record<string, unknown> };
      expect(route.status.phase).toBe('Active');
    });
  });
});
