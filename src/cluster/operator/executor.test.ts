import { describe, it, expect, vi } from 'vitest';
import { K8sNodeInventory, K8sVolumeObjects, conversationVolumeBody, createMigrateCaller } from './executor.js';

describe('K8sNodeInventory', () => {
  it('returns sorted Ready node names excluding a node', async () => {
    const coreApi = {
      listNode: vi.fn(async () => ({
        items: [
          { metadata: { name: 'n2' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
          { metadata: { name: 'n1' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
          { metadata: { name: 'n3' }, status: { conditions: [{ type: 'Ready', status: 'False' }] } },
        ],
      })),
    };
    const inventory = new K8sNodeInventory(coreApi);
    expect(await inventory.listReadyNodeNames('n1')).toEqual(['n2']);
    expect(await inventory.listReadyNodeNames()).toEqual(['n1', 'n2']);
  });

  it('returns empty list when nothing is Ready', async () => {
    const coreApi = { listNode: vi.fn(async () => ({ items: [] })) };
    expect(await new K8sNodeInventory(coreApi).listReadyNodeNames()).toEqual([]);
  });
});

describe('createMigrateCaller', () => {
  const jsonResponse = (ok: boolean, status: number, body: unknown) => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: vi.fn().mockResolvedValue(body),
  });

  it('posts migrate with bearer auth and returns the result', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(true, 200, { sessionId: 's1', nodeName: 'n2', resumed: true }));
    const caller = createMigrateCaller({ apiKey: 'secret', fetchFn: fetchFn as unknown as typeof fetch });

    const result = await caller.callMigrate('http://owner:8080/', 'conv-1', 'n2');

    expect(fetchFn).toHaveBeenCalledWith(
      'http://owner:8080/api/conversations/conv-1/migrate',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ nodeName: 'n2' }),
      }),
    );
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe('Bearer secret');
    expect(result).toEqual({ resumed: true, sessionId: 's1', nodeName: 'n2' });
  });

  it('throws on non-2xx responses', async () => {
    const fetchFn = vi.fn(
      async () => jsonResponse(false, 409, { error: { message: 'not running' } }),
    );
    const caller = createMigrateCaller({ fetchFn: fetchFn as unknown as typeof fetch });

    await expect(caller.callMigrate('http://owner:8080', 'c', 'n')).rejects.toThrow(/HTTP 409.*not running/);
  });

  it('aborts after the timeout', async () => {
    const fetchFn = vi.fn(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const caller = createMigrateCaller({ timeoutMs: 50, fetchFn: fetchFn as unknown as typeof fetch });

    await expect(caller.callMigrate('http://owner:8080', 'c', 'n')).rejects.toThrow();
  });
});

describe('conversationVolumeBody', () => {
  it('builds an RWO claim with the plan naming', () => {
    const body = conversationVolumeBody('abc', '10Gi') as {
      metadata: { name: string };
      spec: { accessModes: string[]; resources: { requests: { storage: string } } };
    };
    expect(body.metadata.name).toBe('conv-abc');
    expect(body.spec.accessModes).toEqual(['ReadWriteOnce']);
    expect(body.spec.resources.requests.storage).toBe('10Gi');
  });
});

describe('K8sVolumeObjects', () => {
  it('delegates to the core API with namespace first', async () => {
    const coreApi = {
      readNamespacedPersistentVolumeClaim: vi.fn(async () => ({})),
      createNamespacedPersistentVolumeClaim: vi.fn(async () => ({})),
      deleteNamespacedPersistentVolumeClaim: vi.fn(async () => undefined),
    };
    const volumes = new K8sVolumeObjects(coreApi as never);
    await volumes.readPersistentVolumeClaim('ns', 'conv-a');
    await volumes.createPersistentVolumeClaim('ns', { kind: 'PersistentVolumeClaim' });
    await volumes.deletePersistentVolumeClaim('ns', 'conv-a');
    expect(coreApi.readNamespacedPersistentVolumeClaim).toHaveBeenCalledWith('conv-a', 'ns');
    expect(coreApi.createNamespacedPersistentVolumeClaim).toHaveBeenCalledWith('ns', { kind: 'PersistentVolumeClaim' });
    expect(coreApi.deleteNamespacedPersistentVolumeClaim).toHaveBeenCalledWith('conv-a', 'ns');
  });
});