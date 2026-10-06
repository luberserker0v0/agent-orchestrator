/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config-loader.js';
import { renderK8sInstallation, type K8sRenderOptions } from './k8s-renderer.js';

function options(overrides: Partial<K8sRenderOptions> = {}): K8sRenderOptions {
  const config = loadConfig();
  config.orchestrator.defaultAgentType = 'opencode-k8s';
  config.orchestrator.runtimes = [{
    id: 'opencode-k8s',
    type: 'kubernetes',
    config: { image: 'ghcr.io/anomalyco/opencode:1.17.8' },
  }];
  return {
    namespace: 'ao-test',
    installation: 'test-install',
    version: '1.2.2',
    image: 'luberserker/agent-orchestrator:1.2.2',
    config,
    workspaceSize: '20Gi',
    conversationStorage: '10Gi',
    operator: true,
    operatorExecute: false,
    ingressClass: 'traefik',
    serviceMonitor: false,
    ...overrides,
  };
}

describe('renderK8sInstallation', () => {
  it('renders deterministic owned resources with version-matched images', () => {
    const first = renderK8sInstallation(options());
    const second = renderK8sInstallation(options());
    expect(second.yaml).toBe(first.yaml);
    expect(first.resources.every(resource => resource.metadata?.labels?.['agentorchestrator.io/installation-id'] === 'test-install')).toBe(true);
    const deployments = first.resources.filter(resource => resource.kind === 'Deployment') as Array<Record<string, any>>;
    expect(deployments).toHaveLength(2);
    expect(deployments.every(resource => resource.spec.template.spec.containers[0].image === 'luberserker/agent-orchestrator:1.2.2')).toBe(true);
  });

  it('rewrites namespaces and Kubernetes runtime configuration', () => {
    const rendered = renderK8sInstallation(options());
    const secret = rendered.resources.find(resource => resource.kind === 'Secret') as Record<string, any>;
    const config = JSON.parse(secret.stringData['agentorchestrator.json']);
    expect(config.cluster.namespace).toBe('ao-test');
    expect(config.orchestrator.runtimes[0].config.namespace).toBe('ao-test');
    expect(config.orchestrator.runtimes[0].config.pvcStorage).toBe('10Gi');
  });

  it('references but does not render an external config Secret', () => {
    const rendered = renderK8sInstallation(options({ config: undefined, existingConfigSecret: 'external-config', cleanupOwnerId: 'owner-a' }));
    expect(rendered.resources.some(resource => resource.kind === 'Secret')).toBe(false);
    const deployment = rendered.resources.find(resource => resource.kind === 'Deployment' && resource.metadata?.name === 'agent-orchestrator') as Record<string, any>;
    expect(deployment.spec.template.spec.volumes[0].secret.secretName).toBe('external-config');
    expect((rendered.inventory as Record<string, any>).data.options).toContain('owner-a');
  });

  it('omits all operator resources when disabled', () => {
    const rendered = renderK8sInstallation(options({ operator: false }));
    expect(rendered.resources.some(resource => resource.metadata?.name === 'placement-controller')).toBe(false);
    expect(rendered.resources.some(resource => resource.metadata?.name?.includes('placement-controller-nodes'))).toBe(false);
  });

  it('requires secret-backed authentication for execute mode', () => {
    expect(() => renderK8sInstallation(options({ operatorExecute: true }))).toThrow(/operator-api-key-secret/);
  });

  it('rejects non-Kubernetes default runtimes', () => {
    const config = loadConfig();
    expect(() => renderK8sInstallation(options({ config }))).toThrow(/kubernetes default runtime/);
  });
});
