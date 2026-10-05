import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  K8sStatusReporter,
  conversationVolumeClaimName,
  currentNodeName,
  resolveReporterConfig,
  type StatusObjectsApi,
} from './status-reporter.js';
import { ErrorCodes } from '../utils/errors.js';
import {
  CLEANUP_ARTIFACT_ANNOTATION,
  CLEANUP_OWNER_ANNOTATION,
  CLEANUP_STATE_ANNOTATION,
  CLEANUP_STATE_SINCE_ANNOTATION,
  persistentDataAnnotations,
} from '../agent-runtime/runtimes/kubernetes.js';

const ARTIFACT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function httpError(statusCode: number): Error {
  const err = new Error(`k8s ${statusCode}`) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

function createFakeApi(): StatusObjectsApi & { calls: Record<string, unknown[][]>; store: Map<string, object> } {
  const store = new Map<string, object>();
  const calls: Record<string, unknown[][]> = {};
  const record = (method: string, args: unknown[]) => {
    calls[method] = [...(calls[method] ?? []), args];
  };
  return {
    calls,
    store,
    createNamespacedCustomObject: vi.fn(async (_g: string, _v: string, _ns: string, _p: string, body: object) => {
      record('create', [body]);
      const name = (body as { metadata: { name: string } }).metadata.name;
      if (store.has(name)) throw httpError(409);
      store.set(name, body);
      return { body };
    }),
    getNamespacedCustomObject: vi.fn(async (_g: string, _v: string, _ns: string, _p: string, name: string) => {
      record('get', [name]);
      const found = store.get(name);
      if (!found) throw httpError(404);
      return { body: found };
    }),
    replaceNamespacedCustomObject: vi.fn(async (_g: string, _v: string, _ns: string, _p: string, name: string, body: object) => {
      record('replace', [name, body]);
      if (!store.has(name)) throw httpError(404);
      store.set(name, body);
      return { body };
    }),
    replaceNamespacedCustomObjectStatus: vi.fn(async (_g: string, _v: string, _ns: string, _p: string, name: string, body: object) => {
      record('replaceStatus', [name, body]);
      if (!store.has(name)) throw httpError(404);
      store.set(name, body);
      return { body };
    }),
    deleteNamespacedCustomObject: vi.fn(async (_g: string, _v: string, _ns: string, _p: string, name: string) => {
      record('delete', [name]);
      if (!store.delete(name)) throw httpError(404);
      return { body: {} };
    }),
    listNamespacedCustomObject: vi.fn(async () => {
      record('list', []);
      return { body: {} };
    }),
  };
}

function enabledReporter(api: StatusObjectsApi): K8sStatusReporter {
  return new K8sStatusReporter(api, {
    enabled: true,
    namespace: 'ao-instances',
    heartbeatIntervalMs: 0,
    quotaFailureThreshold: 2,
  });
}

describe('resolveReporterConfig', () => {
  it('applies defaults', () => {
    expect(resolveReporterConfig(undefined)).toEqual({
      enabled: false,
      namespace: 'ao-instances',
      heartbeatIntervalMs: 60000,
      quotaFailureThreshold: 2,
    });
  });

  it('respects explicit values', () => {
    expect(resolveReporterConfig({ enabled: true, namespace: 'x', heartbeatIntervalMs: 0, quotaFailureThreshold: 5 })).toEqual({
      enabled: true,
      namespace: 'x',
      heartbeatIntervalMs: 0,
      quotaFailureThreshold: 5,
    });
  });
});

describe('helpers', () => {
  it('builds volume claim names', () => {
    expect(conversationVolumeClaimName('abc')).toBe('conv-abc');
  });

  it('prefers NODE_NAME env for node name', () => {
    process.env.NODE_NAME = 'node-x';
    expect(currentNodeName()).toBe('node-x');
    delete process.env.NODE_NAME;
    expect(typeof currentNodeName()).toBe('string');
  });
});

describe('K8sStatusReporter', () => {
  let api: ReturnType<typeof createFakeApi>;

  beforeEach(() => {
    api = createFakeApi();
  });

  it('disabled reporter no-ops everything', async () => {
    const reporter = new K8sStatusReporter(undefined, resolveReporterConfig(undefined));
    expect(reporter.isEnabled()).toBe(false);
    await reporter.trackInstance({ conversationId: 'c1' });
    await reporter.reportQuotaError('c1', { code: ErrorCodes.LLM_QUOTA_EXHAUSTED, message: 'x' });
    await reporter.reportSuccess('c1');
    await reporter.markPersistentDataDeletePending('c1');
    await reporter.untrackInstance('c1');
    expect(reporter.trackedCount()).toBe(0);
    expect(api.calls).toEqual({});
  });

  it('create() with disabled config returns disabled reporter', async () => {
    const reporter = await K8sStatusReporter.create({ enabled: false });
    expect(reporter.isEnabled()).toBe(false);
    reporter.destroy();
  });

  it('trackInstance creates object and marks Ready', async () => {
    const reporter = enabledReporter(api);
    const persistentDataAnnotations = {
      'agentorchestrator.io/cleanup-owner': 'owner-a',
      'agentorchestrator.io/cleanup-artifact': ARTIFACT,
      'agentorchestrator.io/cleanup-state': 'active',
      'agentorchestrator.io/cleanup-state-since': '2026-10-04T00:00:00.000Z',
    };
    await reporter.trackInstance({
      conversationId: 'c1',
      runtimeType: 'direct',
      endpoint: 'http://x:3000',
      volumeClaimName: 'conv-c1',
      model: { providerID: 'anthropic', id: 'm' },
      nodeName: 'worker-1',
      persistentDataAnnotations,
    });
    const created = api.calls.create[0][0] as {
      metadata: { annotations: Record<string, string> };
      spec: Record<string, unknown>;
    };
    expect(created.spec.conversationId).toBe('c1');
    expect(created.spec.volumeClaimName).toBe('conv-c1');
    expect(created.spec.nodeName).toBe('worker-1');
    expect(created.metadata.annotations).toEqual(persistentDataAnnotations);
    expect(reporter.cleanupContext()).toEqual({ namespace: 'ao-instances', api });
    const patched = api.calls.replaceStatus[0][1] as { status: Record<string, unknown> };
    expect(patched.status.phase).toBe('Ready');
    expect(reporter.trackedCount()).toBe(1);
    reporter.destroy();
  });

  it('flips to QuotaExhausted after threshold consecutive quota errors', async () => {
    const reporter = enabledReporter(api);
    await reporter.trackInstance({ conversationId: 'c1' });
    const quota = { code: ErrorCodes.LLM_QUOTA_EXHAUSTED, message: 'quota!', retryAfterMs: 1000 };

    await reporter.reportQuotaError('c1', quota);
    let last = api.calls.replaceStatus.at(-1)![1] as { status: Record<string, unknown> };
    expect(last.status.phase).toBe('Ready');
    expect(last.status.consecutiveFailures).toBe(1);

    await reporter.reportQuotaError('c1', quota);
    last = api.calls.replaceStatus.at(-1)![1] as { status: Record<string, unknown> };
    expect(last.status.phase).toBe('QuotaExhausted');
    expect(last.status.reachable).toBe(false);
    expect(last.status.consecutiveFailures).toBe(2);
    expect((last.status.lastQuotaError as { message: string }).message).toBe('quota!');
    reporter.destroy();
  });

  it('marks RateLimited (reachable) for rate-limit errors', async () => {
    const reporter = enabledReporter(api);
    await reporter.trackInstance({ conversationId: 'c1' });
    await reporter.reportQuotaError('c1', { code: ErrorCodes.LLM_RATE_LIMITED, message: 'slow' });
    const last = api.calls.replaceStatus.at(-1)![1] as { status: Record<string, unknown> };
    expect(last.status.phase).toBe('RateLimited');
    expect(last.status.reachable).toBe(true);
    reporter.destroy();
  });

  it('reportSuccess resets counter and flips back to Ready', async () => {
    const reporter = enabledReporter(api);
    await reporter.trackInstance({ conversationId: 'c1' });
    await reporter.reportQuotaError('c1', { code: ErrorCodes.LLM_QUOTA_EXHAUSTED, message: 'x' });
    await reporter.reportQuotaError('c1', { code: ErrorCodes.LLM_QUOTA_EXHAUSTED, message: 'x' });
    await reporter.reportSuccess('c1');
    const last = api.calls.replaceStatus.at(-1)![1] as { status: Record<string, unknown> };
    expect(last.status.phase).toBe('Ready');
    expect(last.status.consecutiveFailures).toBe(0);
    reporter.destroy();
  });

  it('patches model into spec when newly known', async () => {
    const reporter = enabledReporter(api);
    await reporter.trackInstance({ conversationId: 'c1' });
    await reporter.reportQuotaError('c1', {
      code: ErrorCodes.LLM_QUOTA_EXHAUSTED,
      message: 'x',
      model: { providerID: 'anthropic', id: 'm' },
    });
    const patched = api.calls.replace.at(-1)![1] as { spec: Record<string, unknown> };
    expect(patched.spec.model).toEqual({ providerID: 'anthropic', id: 'm' });
    reporter.destroy();
  });

  it('reportMoved refreshes endpoint and heartbeat', async () => {
    const reporter = enabledReporter(api);
    await reporter.trackInstance({
      conversationId: 'c1',
      runtimeType: 'kubernetes',
      endpoint: 'http://old:30000',
      volumeClaimName: 'conv-c1',
    });
    await reporter.reportMoved('c1', { endpoint: 'http://new:31000', nodeName: 'worker-2' });
    const replaced = api.calls.replace.at(-1)![1] as {
      spec: Record<string, unknown>;
      status: Record<string, unknown>;
    };
    expect(replaced.spec.endpoint).toBe('http://new:31000');
    expect(replaced.spec.nodeName).toBe('worker-2');
    expect(replaced.spec.volumeClaimName).toBe('conv-c1');
    const status = api.calls.replaceStatus.at(-1)![1] as { status: Record<string, unknown> };
    expect(status.status.phase).toBe('Ready');
    expect(status.status.reachable).toBe(true);
    expect(status.status.consecutiveFailures).toBe(0);
    expect(status.status.lastHeartbeat).toBeDefined();
    reporter.destroy();
  });

  it('reportMoved recreates missing objects', async () => {
    const reporter = enabledReporter(api);
    await reporter.reportMoved('ghost', { endpoint: 'http://x:1' });
    expect(api.store.has('ghost')).toBe(true);
    expect(reporter.trackedCount()).toBe(1);
    reporter.destroy();
  });

  it('propagates reportedBy into status patches once set', async () => {
    const reporter = enabledReporter(api);
    await reporter.trackInstance({ conversationId: 'c1' });
    reporter.setAdvertiseBaseUrl('http://owner:8080');
    await reporter.reportQuotaError('c1', { code: 'LLM_RATE_LIMITED', message: 'slow' });
    const last = api.calls.replaceStatus.at(-1)![1] as { status: Record<string, unknown> };
    expect(last.status.phase).toBe('RateLimited');
    expect(last.status.reportedBy).toBe('http://owner:8080');
    reporter.destroy();
  });

  it('omits reportedBy when never set', async () => {
    const reporter = enabledReporter(api);
    await reporter.trackInstance({ conversationId: 'c1' });
    const first = api.calls.replaceStatus.at(-1)![1] as { status: Record<string, unknown> };
    expect(first.status).not.toHaveProperty('reportedBy');
    reporter.destroy();
  });

  it('reportStopped marks Stopped without deleting', async () => {
    const reporter = enabledReporter(api);
    await reporter.trackInstance({ conversationId: 'c1' });
    await reporter.reportStopped('c1');
    const last = api.calls.replaceStatus.at(-1)![1] as { status: Record<string, unknown> };
    expect(last.status.phase).toBe('Stopped');
    expect(last.status.reachable).toBe(false);
    expect(api.calls.delete ?? []).toHaveLength(0);
    reporter.destroy();
  });

  it('durably mirrors delete-pending ownership onto the instance record', async () => {
    const reporter = enabledReporter(api);
    const annotations = persistentDataAnnotations(
      'owner-a',
      'active',
      '2026-10-04T00:00:00.000Z',
      ARTIFACT,
    );
    await reporter.trackInstance({
      conversationId: 'c1',
      runtimeType: 'kubernetes',
      volumeClaimName: 'conv-c1',
      persistentDataAnnotations: annotations,
    });

    await reporter.markPersistentDataDeletePending('c1');

    const updated = api.store.get('c1') as { metadata: { annotations: Record<string, string> } };
    expect(updated.metadata.annotations).toMatchObject({
      [CLEANUP_OWNER_ANNOTATION]: 'owner-a',
      [CLEANUP_ARTIFACT_ANNOTATION]: ARTIFACT,
      [CLEANUP_STATE_ANNOTATION]: 'delete-pending',
    });
    expect(Date.parse(updated.metadata.annotations[CLEANUP_STATE_SINCE_ANNOTATION]))
      .toBeGreaterThan(Date.parse(annotations[CLEANUP_STATE_SINCE_ANNOTATION]));
  });

  it('refuses to mark malformed instance ownership metadata', async () => {
    const reporter = enabledReporter(api);
    await reporter.trackInstance({
      conversationId: 'c1',
      persistentDataAnnotations: {
        ...persistentDataAnnotations('owner-a', 'active'),
        [CLEANUP_ARTIFACT_ANNOTATION]: 'not-a-uuid',
      },
    });

    await expect(reporter.markPersistentDataDeletePending('c1'))
      .rejects.toThrow('incomplete cleanup ownership metadata');
  });

  it('untrackInstance deletes and tolerates 404', async () => {
    const reporter = enabledReporter(api);
    await reporter.trackInstance({ conversationId: 'c1' });
    await reporter.untrackInstance('c1');
    expect(api.calls.delete[0][0]).toBe('c1');
    expect(reporter.trackedCount()).toBe(0);
    await reporter.untrackInstance('missing');
    reporter.destroy();
  });

  it('adopts existing objects on 409', async () => {
    const reporter = enabledReporter(api);
    await reporter.trackInstance({ conversationId: 'c1', endpoint: 'http://old:1', nodeName: 'worker-1' });
    const reporter2 = enabledReporter(api);
    await reporter2.trackInstance({ conversationId: 'c1', endpoint: 'http://new:2', nodeName: 'worker-2' });
    expect(reporter2.trackedCount()).toBe(1);
    const adopted = api.store.get('c1') as { spec: Record<string, unknown>; status: Record<string, unknown> };
    expect(adopted.spec.endpoint).toBe('http://new:2');
    expect(adopted.spec.nodeName).toBe('worker-2');
    expect(adopted.status.phase).toBe('Ready');
    reporter.destroy();
    reporter2.destroy();
  });

  it('never throws on api failures', async () => {
    const failing = createFakeApi();
    failing.replaceNamespacedCustomObjectStatus = vi.fn(async () => {
      throw new Error('down');
    });
    const reporter = enabledReporter(failing);
    await reporter.trackInstance({ conversationId: 'c1' });
    await reporter.reportQuotaError('c1', { code: ErrorCodes.LLM_QUOTA_EXHAUSTED, message: 'x' });
    await reporter.reportSuccess('c1');
    await reporter.untrackInstance('c1');
    reporter.destroy();
  });
});
