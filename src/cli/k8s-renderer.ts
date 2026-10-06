/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KubernetesObject } from '@kubernetes/client-node';
import { parseAllDocuments, stringify } from 'yaml';
import type { AgentOrchestratorConfig } from '../config-loader.js';

const PART_OF = 'agent-orchestrator';
const MANAGED_BY = 'aor';
const INSTALLATION_LABEL = 'agentorchestrator.io/installation-id';
const INVENTORY_NAME = 'agent-orchestrator-installation';
const DEFAULT_CLEANUP_OWNER = 'agent-orchestrator';

const BASE_TEMPLATES = [
  'namespace.yaml',
  'crd/opencodeinstances.yaml',
  'crd/conversationroutes.yaml',
  'orchestrator/serviceaccount.yaml',
  'orchestrator/role.yaml',
  'orchestrator/rolebinding.yaml',
  'orchestrator/workspace-pvc.yaml',
  'orchestrator/secret.yaml',
  'orchestrator/service.yaml',
  'orchestrator/deployment.yaml',
  'operator/serviceaccount.yaml',
  'operator/role.yaml',
  'operator/rolebinding.yaml',
  'operator/clusterrole.yaml',
  'operator/deployment.yaml',
] as const;

export interface K8sRenderOptions {
  namespace: string;
  installation: string;
  version: string;
  image: string;
  config?: AgentOrchestratorConfig;
  existingConfigSecret?: string;
  workspaceSize: string;
  conversationStorage: string;
  storageClass?: string;
  operator: boolean;
  operatorExecute: boolean;
  operatorApiKeySecret?: { name: string; key: string };
  ingressHost?: string;
  ingressClass: string;
  tlsSecret?: string;
  serviceMonitor: boolean;
  cleanupOwnerId?: string;
}

export interface RenderedInstallation {
  resources: KubernetesObject[];
  yaml: string;
  inventory: KubernetesObject;
  configSecretName: string;
}

export function renderK8sInstallation(options: K8sRenderOptions): RenderedInstallation {
  validateDnsLabel(options.namespace, 'namespace');
  validateDnsLabel(options.installation, 'installation');
  validateQuantity(options.workspaceSize, 'workspace size');
  validateQuantity(options.conversationStorage, 'conversation storage');
  if (!options.config && !options.existingConfigSecret) throw new Error('A config file or existing config Secret is required');
  if (options.config && options.existingConfigSecret) throw new Error('Config file and existing config Secret are mutually exclusive');
  if (options.operatorExecute && !options.operatorApiKeySecret) {
    throw new Error('--operator-execute requires --operator-api-key-secret <name:key>');
  }

  const configSecretName = options.existingConfigSecret ?? 'agent-orchestrator-config';
  validateDnsLabel(configSecretName, 'config Secret');
  const resources = BASE_TEMPLATES.flatMap(relative => readTemplate(relative));
  if (options.ingressHost) resources.push(...readTemplate('orchestrator/ingress.yaml'));
  if (options.serviceMonitor) resources.push(...readTemplate('orchestrator/servicemonitor.yaml'));

  const clusterRoleName = safeName(`${options.installation}-${options.namespace}-placement-controller-nodes`);
  const transformed = resources.flatMap(resource => {
    if (!options.operator && isOperatorResource(resource)) return [];
    if (resource.kind === 'Secret' && resource.metadata?.name === 'agent-orchestrator-config' && options.existingConfigSecret) return [];

    const item = structuredClone(resource) as KubernetesObject & Record<string, any>;
    item.metadata ??= {};
    item.metadata.labels = {
      ...(item.metadata.labels ?? {}),
      'app.kubernetes.io/part-of': PART_OF,
      'app.kubernetes.io/managed-by': MANAGED_BY,
      [INSTALLATION_LABEL]: options.installation,
    };
    item.metadata.annotations = {
      ...(item.metadata.annotations ?? {}),
      'agentorchestrator.io/cli-version': options.version,
    };

    if (item.kind === 'Namespace') item.metadata.name = options.namespace;
    else if (isNamespaced(item)) item.metadata.namespace = options.namespace;

    patchNamespacedReferences(item, options.namespace);
    if (item.kind === 'ClusterRole' && item.metadata.name === 'placement-controller-nodes') item.metadata.name = clusterRoleName;
    if (item.kind === 'ClusterRoleBinding' && item.metadata.name === 'placement-controller-nodes') {
      item.metadata.name = clusterRoleName;
      item.roleRef.name = clusterRoleName;
    }
    if (item.kind === 'PersistentVolumeClaim' && item.metadata.name === 'ao-workspace') {
      item.spec.resources.requests.storage = options.workspaceSize;
      if (options.storageClass) item.spec.storageClassName = options.storageClass;
    }
    if (item.kind === 'Secret' && item.metadata.name === 'agent-orchestrator-config' && options.config) {
      item.stringData = { 'agentorchestrator.json': JSON.stringify(kubernetesConfig(options.config, options), null, 2) };
    }
    if (item.kind === 'Deployment') patchDeployment(item, options, configSecretName);
    if (item.kind === 'Ingress') patchIngress(item, options);
    return [item];
  });

  const inventory = createInventory(options, transformed, configSecretName);
  const withInventory = insertAfterNamespace(transformed, inventory);
  return {
    resources: withInventory,
    yaml: withInventory.map(resource => stringify(resource, { lineWidth: 0 }).trim()).join('\n---\n') + '\n',
    inventory,
    configSecretName,
  };
}

export function resourceIdentity(resource: KubernetesObject): string {
  const namespace = resource.metadata?.namespace ? `${resource.metadata.namespace}/` : '';
  return `${resource.apiVersion}:${resource.kind}:${namespace}${resource.metadata?.name}`;
}

export function hasInstallationOwnership(resource: KubernetesObject, installation: string): boolean {
  return resource.metadata?.labels?.['app.kubernetes.io/managed-by'] === MANAGED_BY
    && resource.metadata?.labels?.[INSTALLATION_LABEL] === installation;
}

export function isNotFound(error: unknown): boolean {
  const status = (error as { statusCode?: number; code?: number; response?: { statusCode?: number } })?.statusCode
    ?? (error as { code?: number })?.code
    ?? (error as { response?: { statusCode?: number } })?.response?.statusCode;
  return status === 404;
}

function readTemplate(relative: string): KubernetesObject[] {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'k8s');
  const source = readFileSync(join(root, ...relative.split('/')), 'utf8');
  return parseAllDocuments(source)
    .map(document => document.toJS() as KubernetesObject | null)
    .filter((resource): resource is KubernetesObject => Boolean(resource?.kind && resource?.metadata?.name));
}

function isNamespaced(resource: KubernetesObject): boolean {
  return resource.kind !== 'Namespace'
    && resource.kind !== 'CustomResourceDefinition'
    && resource.kind !== 'ClusterRole'
    && resource.kind !== 'ClusterRoleBinding';
}

function isOperatorResource(resource: KubernetesObject): boolean {
  const component = resource.metadata?.labels?.['agentorchestrator.io/component'];
  return resource.metadata?.name === 'placement-controller'
    || resource.metadata?.name === 'placement-controller-nodes'
    || component === 'placement-controller';
}

function patchNamespacedReferences(resource: KubernetesObject & Record<string, any>, namespace: string): void {
  if (resource.kind === 'RoleBinding' || resource.kind === 'ClusterRoleBinding') {
    for (const subject of resource.subjects ?? []) {
      if (subject.kind === 'ServiceAccount') subject.namespace = namespace;
    }
  }
}

function patchDeployment(resource: KubernetesObject & Record<string, any>, options: K8sRenderOptions, configSecretName: string): void {
  resource.spec.template.metadata ??= {};
  resource.spec.template.metadata.labels = {
    ...(resource.spec.template.metadata.labels ?? {}),
    'app.kubernetes.io/managed-by': MANAGED_BY,
    [INSTALLATION_LABEL]: options.installation,
  };
  const podSpec = resource.spec.template.spec;
  const container = podSpec.containers[0];
  container.image = options.image;
  const configVolume = podSpec.volumes?.find((volume: any) => volume.name === 'config');
  if (configVolume?.secret) configVolume.secret.secretName = configSecretName;

  if (resource.metadata?.name === 'placement-controller') {
    const args: string[] = container.args ?? [];
    replaceArg(args, '--namespace', options.namespace);
    replaceArg(args, '--pvc-storage', options.conversationStorage);
    if (options.operatorExecute && !args.includes('--execute')) args.push('--execute');
    if (options.operatorExecute && options.operatorApiKeySecret) {
      container.env = [
        ...(container.env ?? []).filter((entry: any) => entry.name !== 'AOR_OPERATOR_API_KEY'),
        {
          name: 'AOR_OPERATOR_API_KEY',
          valueFrom: { secretKeyRef: { name: options.operatorApiKeySecret.name, key: options.operatorApiKeySecret.key } },
        },
      ];
    }
  }
}

function replaceArg(args: string[], name: string, value: string): void {
  const index = args.indexOf(name);
  if (index >= 0) args[index + 1] = value;
  else args.push(name, value);
}

function patchIngress(resource: KubernetesObject & Record<string, any>, options: K8sRenderOptions): void {
  resource.spec.ingressClassName = options.ingressClass;
  resource.spec.rules[0].host = options.ingressHost;
  if (options.tlsSecret) {
    resource.spec.tls = [{ hosts: [options.ingressHost], secretName: options.tlsSecret }];
    resource.metadata!.annotations!['traefik.ingress.kubernetes.io/service.sticky.cookie.secure'] = 'true';
  }
}

function kubernetesConfig(config: AgentOrchestratorConfig, options: K8sRenderOptions): AgentOrchestratorConfig {
  const result = structuredClone(config);
  const defaultRuntime = result.orchestrator.runtimes.find(runtime => runtime.id === result.orchestrator.defaultAgentType);
  if (defaultRuntime?.type !== 'kubernetes') {
    throw new Error('Kubernetes installation config must use a kubernetes default runtime');
  }
  result.server.host = '0.0.0.0';
  result.server.port = 8080;
  result.workspace.basePath = '/data/workspace';
  result.cluster = {
    ...(result.cluster ?? {}),
    enabled: true,
    namespace: options.namespace,
    advertiseBaseUrl: `http://agent-orchestrator.${options.namespace}.svc.cluster.local:8080`,
  };
  for (const runtime of result.orchestrator.runtimes) {
    if (runtime.type !== 'kubernetes') continue;
    runtime.config.namespace = options.namespace;
    runtime.config.pvcStorage = options.conversationStorage;
  }
  return result;
}

function createInventory(options: K8sRenderOptions, resources: KubernetesObject[], configSecretName: string): KubernetesObject {
  const identities = [
    ...resources.map(resourceIdentity),
    `v1:ConfigMap:${options.namespace}/${INVENTORY_NAME}`,
  ].sort();
  const safeOptions = {
    namespace: options.namespace,
    installation: options.installation,
    image: options.image,
    configSource: options.existingConfigSecret ? 'external-secret' : 'owned-secret',
    configSecretName,
    workspaceSize: options.workspaceSize,
    conversationStorage: options.conversationStorage,
    storageClass: options.storageClass ?? '',
    operator: options.operator,
    operatorExecute: options.operatorExecute,
    operatorApiKeySecret: options.operatorApiKeySecret
      ? `${options.operatorApiKeySecret.name}:${options.operatorApiKeySecret.key}`
      : '',
    ingressHost: options.ingressHost ?? '',
    ingressClass: options.ingressClass,
    tlsSecret: options.tlsSecret ?? '',
    serviceMonitor: options.serviceMonitor,
    cleanupOwnerId: options.cleanupOwnerId ?? options.config?.cleanup.ownerId ?? DEFAULT_CLEANUP_OWNER,
  };
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: INVENTORY_NAME,
      namespace: options.namespace,
      labels: {
        'app.kubernetes.io/part-of': PART_OF,
        'app.kubernetes.io/managed-by': MANAGED_BY,
        [INSTALLATION_LABEL]: options.installation,
      },
      annotations: { 'agentorchestrator.io/cli-version': options.version },
    },
    data: {
      version: options.version,
      installation: options.installation,
      options: JSON.stringify(safeOptions),
      optionsHash: createHash('sha256').update(JSON.stringify(safeOptions)).digest('hex'),
      resources: JSON.stringify(identities),
    },
  } as KubernetesObject;
}

function insertAfterNamespace(resources: KubernetesObject[], inventory: KubernetesObject): KubernetesObject[] {
  const index = resources.findIndex(resource => resource.kind === 'Namespace');
  return [...resources.slice(0, index + 1), inventory, ...resources.slice(index + 1)];
}

function validateDnsLabel(value: string, field: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) throw new Error(`Invalid ${field}: ${value}`);
}

function validateQuantity(value: string, field: string): void {
  if (!/^[1-9][0-9]*(?:m|Ki|Mi|Gi|Ti|Pi|Ei)?$/.test(value)) throw new Error(`Invalid ${field}: ${value}`);
}

function safeName(value: string): string {
  if (value.length <= 63) return value;
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return `${value.slice(0, 54).replace(/-+$/, '')}-${hash}`;
}
