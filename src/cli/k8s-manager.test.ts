import type { KubernetesObject, KubernetesObjectApi } from '@kubernetes/client-node';
import { describe, expect, it, vi } from 'vitest';
import { K8sInstallationManager } from './k8s-manager.js';
import type { RenderedInstallation } from './k8s-renderer.js';

const labels = {
  'app.kubernetes.io/managed-by': 'aor',
  'app.kubernetes.io/part-of': 'agent-orchestrator',
  'agentorchestrator.io/installation-id': 'test-install',
};

function resource(kind: string, name: string, namespace?: string): KubernetesObject {
  return {
    apiVersion: kind === 'Deployment' ? 'apps/v1' : 'v1',
    kind,
    metadata: { name, ...(namespace ? { namespace } : {}), labels },
  };
}

function manager(api: Record<string, unknown>): K8sInstallationManager {
  return new K8sInstallationManager({}, 'ao-test', 'test-install', api as unknown as KubernetesObjectApi);
}

describe('K8sInstallationManager', () => {
  it('server-side applies owned resources and waits for deployments', async () => {
    let deploymentApplied = false;
    const read = vi.fn(async (header: { kind: string; metadata: { name: string } }) => {
      if (header.kind === 'Deployment' && deploymentApplied) {
        return {
          ...resource('Deployment', header.metadata.name, 'ao-test'),
          metadata: { ...resource('Deployment', header.metadata.name, 'ao-test').metadata, generation: 1 },
          spec: { replicas: 1 },
          status: { observedGeneration: 1, availableReplicas: 1 },
        };
      }
      throw { statusCode: 404 };
    });
    const patch = vi.fn(async (item: KubernetesObject) => {
      if (item.kind === 'Deployment') deploymentApplied = true;
      return item;
    });
    const deployment = {
      ...resource('Deployment', 'agent-orchestrator', 'ao-test'),
      spec: { replicas: 1, selector: {}, template: { metadata: {}, spec: { containers: [] } } },
    };
    const rendered: RenderedInstallation = {
      resources: [resource('Namespace', 'ao-test'), deployment],
      yaml: '',
      inventory: resource('ConfigMap', 'agent-orchestrator-installation', 'ao-test'),
      configSecretName: 'agent-orchestrator-config',
    };
    const report = await manager({ read, patch }).apply(rendered, 100);
    expect(report.applied).toHaveLength(2);
    expect(report.ready).toEqual(['apps/v1:Deployment:ao-test/agent-orchestrator']);
    expect(patch).toHaveBeenCalledTimes(2);
  });

  it('refuses to overwrite a same-name foreign resource', async () => {
    const read = vi.fn().mockResolvedValue({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'ao-test' } });
    const patch = vi.fn();
    const rendered: RenderedInstallation = {
      resources: [resource('Namespace', 'ao-test')],
      yaml: '',
      inventory: resource('ConfigMap', 'agent-orchestrator-installation', 'ao-test'),
      configSecretName: 'agent-orchestrator-config',
    };
    await expect(manager({ read, patch }).apply(rendered, 100)).rejects.toThrow(/foreign resource/);
    expect(patch).not.toHaveBeenCalled();
  });

  it('preserves CRD enum fields through the generated Kubernetes client serializer', async () => {
    const read = vi.fn().mockRejectedValue({ statusCode: 404 });
    const patch = vi.fn().mockResolvedValue({});
    const crd = {
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'examples.test.io', labels },
      spec: { versions: [{ schema: { openAPIV3Schema: { properties: { phase: { enum: ['Ready', 'Stopped'] } } } } }] },
    } as KubernetesObject;
    const rendered: RenderedInstallation = {
      resources: [crd],
      yaml: '',
      inventory: resource('ConfigMap', 'agent-orchestrator-installation', 'ao-test'),
      configSecretName: 'agent-orchestrator-config',
    };
    await manager({ read, patch }).apply(rendered, 100);
    expect(patch.mock.calls[0][0]).toMatchObject({
      spec: { versions: [{ schema: { openAPIV3Schema: { properties: { phase: { _enum: ['Ready', 'Stopped'] } } } } }] },
    });
  });

  it('adopts compatible resources by patching metadata only', async () => {
    const legacy = { apiVersion: 'v1', kind: 'Service', metadata: { name: 'agent-orchestrator', namespace: 'ao-test' } };
    const read = vi.fn().mockResolvedValue(legacy);
    const patch = vi.fn().mockImplementation(async value => value);
    const rendered: RenderedInstallation = {
      resources: [resource('Service', 'agent-orchestrator', 'ao-test')],
      yaml: '',
      inventory: resource('ConfigMap', 'agent-orchestrator-installation', 'ao-test'),
      configSecretName: 'agent-orchestrator-config',
    };
    const report = await manager({ read, patch }).adopt(rendered);
    expect(report.adopted).toEqual(['v1:Service:ao-test/agent-orchestrator']);
    const body = patch.mock.calls[0][0] as KubernetesObject;
    expect(body.metadata?.labels).toMatchObject(labels);
    expect((body as Record<string, unknown>).spec).toBeUndefined();
  });

  it('refuses to adopt a Service with an incompatible selector', async () => {
    const legacy = {
      apiVersion: 'v1', kind: 'Service', metadata: { name: 'agent-orchestrator', namespace: 'ao-test' },
      spec: { selector: { app: 'foreign' } },
    };
    const read = vi.fn().mockResolvedValue(legacy);
    const patch = vi.fn();
    const desired = {
      ...resource('Service', 'agent-orchestrator', 'ao-test'),
      spec: { selector: { app: 'agent-orchestrator' } },
    };
    const rendered: RenderedInstallation = {
      resources: [desired], yaml: '',
      inventory: resource('ConfigMap', 'agent-orchestrator-installation', 'ao-test'),
      configSecretName: 'agent-orchestrator-config',
    };
    await expect(manager({ read, patch }).adopt(rendered)).rejects.toThrow(/incompatible selector/);
    expect(patch).not.toHaveBeenCalled();
  });

  it('adopts a compatible CRD with Kubernetes-defaulted name fields', async () => {
    const desired = {
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'examples.test.io', labels },
      spec: {
        group: 'test.io',
        scope: 'Namespaced',
        names: { plural: 'examples', singular: 'example', kind: 'Example', shortNames: ['ex'] },
        versions: [{ name: 'v1', served: true, storage: true }],
      },
    } as KubernetesObject;
    const current = structuredClone(desired) as KubernetesObject & { spec: { names: Record<string, unknown> } };
    current.metadata = { name: 'examples.test.io' };
    current.spec.names.listKind = 'ExampleList';
    current.spec.names.categories = ['all'];
    const read = vi.fn().mockResolvedValue(current);
    const patch = vi.fn().mockResolvedValue({});
    const rendered: RenderedInstallation = {
      resources: [desired], yaml: '', inventory: resource('ConfigMap', 'agent-orchestrator-installation', 'ao-test'),
      configSecretName: 'agent-orchestrator-config',
    };

    await expect(manager({ read, patch }).adopt(rendered)).resolves.toMatchObject({
      adopted: ['apiextensions.k8s.io/v1:CustomResourceDefinition:examples.test.io'],
    });
    expect(patch).toHaveBeenCalledOnce();
  });

  it('refuses to adopt a CRD with a different resource kind', async () => {
    const desired = {
      apiVersion: 'apiextensions.k8s.io/v1',
      kind: 'CustomResourceDefinition',
      metadata: { name: 'examples.test.io', labels },
      spec: {
        group: 'test.io',
        scope: 'Namespaced',
        names: { plural: 'examples', singular: 'example', kind: 'Example' },
        versions: [{ name: 'v1', served: true, storage: true }],
      },
    } as KubernetesObject;
    const current = structuredClone(desired) as KubernetesObject & { spec: { names: Record<string, unknown> } };
    current.metadata = { name: 'examples.test.io' };
    current.spec.names.kind = 'ForeignExample';
    const read = vi.fn().mockResolvedValue(current);
    const patch = vi.fn();
    const rendered: RenderedInstallation = {
      resources: [desired], yaml: '', inventory: resource('ConfigMap', 'agent-orchestrator-installation', 'ao-test'),
      configSecretName: 'agent-orchestrator-config',
    };

    await expect(manager({ read, patch }).adopt(rendered)).rejects.toThrow(/incompatible API identity/);
    expect(patch).not.toHaveBeenCalled();
  });

  it('normal uninstall deletes control-plane resources and preserves data', async () => {
    const inventory = {
      ...resource('ConfigMap', 'agent-orchestrator-installation', 'ao-test'),
      data: {
        resources: JSON.stringify([
          'apps/v1:Deployment:ao-test/agent-orchestrator',
          'v1:PersistentVolumeClaim:ao-test/ao-workspace',
          'v1:ConfigMap:ao-test/agent-orchestrator-installation',
        ]),
        options: '{}',
      },
    };
    const objects = new Map([
      ['ConfigMap/agent-orchestrator-installation', inventory],
      ['Deployment/agent-orchestrator', resource('Deployment', 'agent-orchestrator', 'ao-test')],
      ['PersistentVolumeClaim/ao-workspace', resource('PersistentVolumeClaim', 'ao-workspace', 'ao-test')],
    ]);
    const read = vi.fn(async (header: { kind: string; metadata: { name: string } }) => objects.get(`${header.kind}/${header.metadata.name}`));
    const remove = vi.fn().mockResolvedValue({});
    const report = await manager({ read, delete: remove }).uninstall(false);
    expect(report.deleted).toEqual(['apps/v1:Deployment:ao-test/agent-orchestrator']);
    expect(report.preserved).toContain('v1:PersistentVolumeClaim:ao-test/ao-workspace');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('refuses a purge before mutating when an owned PVC is still referenced', async () => {
    const inventory = {
      ...resource('ConfigMap', 'agent-orchestrator-installation', 'ao-test'),
      data: {
        resources: JSON.stringify(['v1:PersistentVolumeClaim:ao-test/ao-workspace']),
        options: JSON.stringify({ cleanupOwnerId: 'owner-a' }),
      },
    };
    const claim = resource('PersistentVolumeClaim', 'ao-workspace', 'ao-test');
    const pod = {
      ...resource('Pod', 'orchestrator', 'ao-test'),
      spec: { volumes: [{ persistentVolumeClaim: { claimName: 'ao-workspace' } }] },
    };
    const read = vi.fn().mockResolvedValue(inventory);
    const list = vi.fn(async (_apiVersion: string, kind: string) => ({ items: kind === 'Pod' ? [pod] : [claim] }));
    const remove = vi.fn();
    await expect(manager({ read, list, delete: remove }).uninstall(true)).rejects.toThrow(/still referenced by Pods/);
    expect(remove).not.toHaveBeenCalled();
  });
});
