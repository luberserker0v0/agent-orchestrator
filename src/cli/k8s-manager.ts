/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
  type KubernetesObject,
  type V1DeleteOptions,
} from '@kubernetes/client-node';
import { validateConfig, type AgentOrchestratorConfig } from '../config-loader.js';
import {
  hasInstallationOwnership,
  isNotFound,
  resourceIdentity,
  type RenderedInstallation,
} from './k8s-renderer.js';

const INSTALLATION_LABEL = 'agentorchestrator.io/installation-id';
const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
const PART_OF_LABEL = 'app.kubernetes.io/part-of';
const CLEANUP_OWNER = 'agentorchestrator.io/cleanup-owner';
const CONVERSATION_LABEL = 'agentorchestrator.io/conversation';
const FIELD_MANAGER_PREFIX = 'agent-orchestrator-cli';

export interface KubeConnectionOptions {
  kubeconfig?: string;
  context?: string;
}

export interface ApplyReport {
  applied: string[];
  ready: string[];
}

export interface InstallationStatus {
  found: boolean;
  namespace: string;
  installation: string;
  version?: string;
  options?: Record<string, unknown>;
  resources: Array<{ identity: string; status: 'ready' | 'present' | 'missing' | 'error'; detail?: string }>;
  persistentVolumeClaims: number;
  desiredImage?: string;
  deployedImages: Array<{ deployment: string; image: string; ready: boolean }>;
  operatorMode: 'disabled' | 'dry-run' | 'execute' | 'unknown';
  endpoints: string[];
}

export interface DoctorReport {
  healthy: boolean;
  checks: Array<{ name: string; status: 'pass' | 'warn' | 'fail'; detail: string }>;
}

export interface UninstallReport {
  deleted: string[];
  preserved: string[];
  skipped: string[];
}

export class K8sInstallationManager {
  private readonly api: KubernetesObjectApi;

  constructor(
    connection: KubeConnectionOptions,
    private readonly namespace: string,
    private readonly installation: string,
    api?: KubernetesObjectApi,
  ) {
    if (api) {
      this.api = api;
      return;
    }
    const kubeConfig = new KubeConfig();
    if (connection.kubeconfig) kubeConfig.loadFromFile(connection.kubeconfig);
    else kubeConfig.loadFromDefault();
    if (connection.context) kubeConfig.setCurrentContext(connection.context);
    this.api = KubernetesObjectApi.makeApiClient(kubeConfig);
  }

  async validateExternalConfigSecret(name: string): Promise<{ cleanupOwnerId?: string; config: AgentOrchestratorConfig }> {
    const secret = await this.api.read<KubernetesObject & Record<string, any>>({
      apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: this.namespace },
    });
    const encoded = secret.data?.['agentorchestrator.json'];
    const plain = secret.stringData?.['agentorchestrator.json']
      ?? (typeof encoded === 'string' ? Buffer.from(encoded, 'base64').toString('utf8') : undefined);
    if (!plain) throw new Error(`Secret ${name} does not contain agentorchestrator.json`);
    try {
      const parsed = JSON.parse(plain) as AgentOrchestratorConfig;
      validateConfig(parsed);
      return {
        config: parsed,
        ...(typeof parsed.cleanup?.ownerId === 'string' ? { cleanupOwnerId: parsed.cleanup.ownerId } : {}),
      };
    } catch {
      throw new Error(`Secret ${name} contains invalid agentorchestrator.json`);
    }
  }

  async apply(rendered: RenderedInstallation, timeoutMs: number): Promise<ApplyReport> {
    const applied: string[] = [];
    for (const resource of rendered.resources) {
      const current = await this.readOptional(resource);
      if (current && !hasInstallationOwnership(current, this.installation)) {
        throw new Error(`Refusing to overwrite foreign resource ${resourceIdentity(resource)}; run aor k8s adopt first`);
      }
      await this.api.patch(
        forKubernetesClient(resource),
        undefined,
        undefined,
        this.fieldManager(),
        true,
        PatchStrategy.ServerSideApply,
      );
      applied.push(resourceIdentity(resource));
    }
    const deployments = rendered.resources.filter(resource => resource.kind === 'Deployment');
    const ready: string[] = [];
    for (const deployment of deployments) {
      await this.waitForDeployment(deployment, timeoutMs);
      ready.push(resourceIdentity(deployment));
    }
    return { applied, ready };
  }

  async adopt(rendered: RenderedInstallation): Promise<{ adopted: string[]; absent: string[] }> {
    const adopted: string[] = [];
    const absent: string[] = [];
    for (const desired of rendered.resources) {
      const current = await this.readOptional(desired);
      if (!current) {
        absent.push(resourceIdentity(desired));
        continue;
      }
      if (hasInstallationOwnership(current, this.installation)) continue;
      assertAdoptable(current, desired);
      const patch: KubernetesObject = {
        apiVersion: desired.apiVersion,
        kind: desired.kind,
        metadata: {
          name: desired.metadata!.name,
          ...(desired.metadata?.namespace ? { namespace: desired.metadata.namespace } : {}),
          labels: {
            ...(current.metadata?.labels ?? {}),
            [PART_OF_LABEL]: 'agent-orchestrator',
            [MANAGED_BY_LABEL]: 'aor',
            [INSTALLATION_LABEL]: this.installation,
          },
          annotations: { ...(current.metadata?.annotations ?? {}), ...(desired.metadata?.annotations ?? {}) },
        },
      };
      await this.api.patch(patch, undefined, undefined, this.fieldManager(), undefined, PatchStrategy.MergePatch);
      adopted.push(resourceIdentity(desired));
    }
    return { adopted, absent };
  }

  async status(): Promise<InstallationStatus> {
    const inventory = await this.readInventory();
    if (!inventory) {
      return {
        found: false,
        namespace: this.namespace,
        installation: this.installation,
        resources: [],
        persistentVolumeClaims: 0,
        deployedImages: [],
        operatorMode: 'unknown',
        endpoints: [],
      };
    }
    const identities = parseStringArray((inventory as Record<string, any>).data?.resources);
    const resources: InstallationStatus['resources'] = [];
    const deployedImages: InstallationStatus['deployedImages'] = [];
    const endpoints: string[] = [];
    for (const identity of identities) {
      try {
        const resource = await this.api.read(asHeader(identityHeader(identity)));
        if (!hasInstallationOwnership(resource, this.installation)) {
          resources.push({ identity, status: 'error', detail: 'ownership mismatch' });
        } else if (resource.kind === 'Deployment') {
          resources.push({ identity, status: deploymentReady(resource) ? 'ready' : 'present', detail: deploymentDetail(resource) });
          const deployment = resource as Record<string, any>;
          deployedImages.push({
            deployment: resource.metadata?.name ?? '',
            image: String(deployment.spec?.template?.spec?.containers?.[0]?.image ?? ''),
            ready: deploymentReady(resource),
          });
        } else {
          resources.push({ identity, status: 'present' });
          if (resource.kind === 'Service' && resource.metadata?.name === 'agent-orchestrator') {
            endpoints.push(`http://agent-orchestrator.${this.namespace}.svc.cluster.local:8080`);
          }
          if (resource.kind === 'Ingress') {
            for (const rule of (resource as Record<string, any>).spec?.rules ?? []) {
              if (rule.host) endpoints.push(`http${(resource as Record<string, any>).spec?.tls ? 's' : ''}://${rule.host}`);
            }
          }
        }
      } catch (error) {
        resources.push({ identity, status: isNotFound(error) ? 'missing' : 'error', ...(!isNotFound(error) ? { detail: safeError(error) } : {}) });
      }
    }
    const claims = await this.list('v1', 'PersistentVolumeClaim', this.namespace);
    const inventoryOptions = parseRecord((inventory as Record<string, any>).data?.options);
    const operatorEnabled = inventoryOptions.operator;
    return {
      found: true,
      namespace: this.namespace,
      installation: this.installation,
      version: String((inventory as Record<string, any>).data?.version ?? ''),
      options: inventoryOptions,
      resources,
      persistentVolumeClaims: claims.filter(resource => isAoClaim(resource)).length,
      ...(typeof inventoryOptions.image === 'string' ? { desiredImage: inventoryOptions.image } : {}),
      deployedImages,
      operatorMode: operatorEnabled === false
        ? 'disabled'
        : operatorEnabled === true
          ? inventoryOptions.operatorExecute === true ? 'execute' : 'dry-run'
          : 'unknown',
      endpoints,
    };
  }

  async doctor(): Promise<DoctorReport> {
    const checks: DoctorReport['checks'] = [];
    try {
      const namespace = await this.api.read({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: this.namespace } });
      checks.push({ name: 'namespace', status: hasInstallationOwnership(namespace, this.installation) ? 'pass' : 'warn', detail: 'reachable' });
    } catch (error) {
      checks.push({ name: 'namespace', status: 'fail', detail: safeError(error) });
    }
    for (const name of ['opencodeinstances.agentorchestrator.io', 'conversationroutes.agentorchestrator.io']) {
      try {
        await this.api.read({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name } });
        checks.push({ name: `crd/${name}`, status: 'pass', detail: 'installed' });
      } catch (error) {
        checks.push({ name: `crd/${name}`, status: 'fail', detail: safeError(error) });
      }
    }
    const status = await this.status();
    checks.push({
      name: 'inventory',
      status: status.found ? 'pass' : 'fail',
      detail: status.found ? `${status.resources.length} tracked resources` : 'installation inventory not found',
    });
    if (status.found) {
      const imageMismatch = status.deployedImages.some(item => status.desiredImage && item.image !== status.desiredImage);
      checks.push({
        name: 'images',
        status: imageMismatch ? 'fail' : 'pass',
        detail: imageMismatch ? 'deployed image differs from installation inventory' : 'deployment images match inventory',
      });
      const secretName = typeof status.options?.configSecretName === 'string' ? status.options.configSecretName : 'agent-orchestrator-config';
      try {
        await this.api.read({ apiVersion: 'v1', kind: 'Secret', metadata: { name: secretName, namespace: this.namespace } });
        checks.push({ name: 'configuration', status: 'pass', detail: `Secret ${secretName} is readable` });
      } catch (error) {
        checks.push({ name: 'configuration', status: 'fail', detail: safeError(error) });
      }
      const storageClass = typeof status.options?.storageClass === 'string' && status.options.storageClass
        ? status.options.storageClass
        : undefined;
      try {
        if (storageClass) {
          await this.api.read({ apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass', metadata: { name: storageClass } });
          checks.push({ name: 'storage', status: 'pass', detail: `StorageClass ${storageClass} is available` });
        } else {
          const classes = await this.list('storage.k8s.io/v1', 'StorageClass');
          const hasDefault = classes.some(item => item.metadata?.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true'
            || item.metadata?.annotations?.['storageclass.beta.kubernetes.io/is-default-class'] === 'true');
          checks.push({ name: 'storage', status: hasDefault ? 'pass' : 'warn', detail: hasDefault ? 'default StorageClass is available' : 'no default StorageClass detected' });
        }
      } catch (error) {
        checks.push({ name: 'storage', status: 'fail', detail: safeError(error) });
      }
      for (const access of [
        { group: 'apps', resource: 'deployments', verb: 'patch', namespace: this.namespace },
        { group: '', resource: 'persistentvolumeclaims', verb: 'delete', namespace: this.namespace },
        { group: 'apiextensions.k8s.io', resource: 'customresourcedefinitions', verb: 'patch' },
      ]) {
        try {
          const review = await this.api.create<KubernetesObject & Record<string, any>>({
            apiVersion: 'authorization.k8s.io/v1',
            kind: 'SelfSubjectAccessReview',
            metadata: {},
            spec: { resourceAttributes: access },
          } as KubernetesObject & Record<string, any>);
          const allowed = review.status?.allowed === true;
          checks.push({ name: `permission:${access.verb}:${access.resource}`, status: allowed ? 'pass' : 'fail', detail: allowed ? 'allowed' : 'denied' });
        } catch (error) {
          checks.push({ name: `permission:${access.verb}:${access.resource}`, status: 'fail', detail: safeError(error) });
        }
      }
    }
    const broken = status.resources.filter(resource => resource.status === 'missing' || resource.status === 'error');
    checks.push({
      name: 'managed-resources',
      status: broken.length === 0 ? 'pass' : 'fail',
      detail: broken.length === 0 ? 'all tracked resources are present' : `${broken.length} tracked resources are missing or invalid`,
    });
    if (status.options?.serviceMonitor === true) {
      try {
        await this.api.read({ apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'servicemonitors.monitoring.coreos.com' } });
        checks.push({ name: 'prometheus-operator', status: 'pass', detail: 'ServiceMonitor CRD installed' });
      } catch {
        checks.push({ name: 'prometheus-operator', status: 'fail', detail: 'ServiceMonitor requested but CRD is absent' });
      }
    }
    return { healthy: checks.every(check => check.status !== 'fail'), checks };
  }

  async uninstall(purgeData: boolean): Promise<UninstallReport> {
    const inventory = await this.readInventory();
    if (!inventory) throw new Error('Installation inventory not found');
    if (purgeData) await this.assertNoReferencedOwnedClaims(inventory);
    const identities = parseStringArray((inventory as Record<string, any>).data?.resources);
    const deleted: string[] = [];
    const preserved: string[] = [];
    const skipped: string[] = [];
    const removable = new Set(['Deployment', 'Service', 'ServiceAccount', 'Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding', 'Ingress', 'ServiceMonitor']);
    const dataKinds = new Set(['PersistentVolumeClaim', 'Secret', 'ConfigMap']);

    for (const identity of [...identities].reverse()) {
      const header = identityHeader(identity);
      if (!purgeData && !removable.has(header.kind!)) {
        preserved.push(identity);
        continue;
      }
      if (purgeData && !removable.has(header.kind!) && !dataKinds.has(header.kind!)) {
        preserved.push(identity);
        continue;
      }
      const current = await this.readOptional(header);
      if (!current) continue;
      if (!hasInstallationOwnership(current, this.installation)) {
        skipped.push(identity);
        continue;
      }
      if (header.kind === 'Namespace') continue;
      await this.deleteWithUid(current);
      deleted.push(identity);
    }

    if (purgeData) {
      await this.purgeConversationData(inventory, deleted, skipped);
      await this.purgeCrds(deleted, preserved, skipped);
      const namespace = await this.readOptional({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: this.namespace } });
      if (namespace && hasInstallationOwnership(namespace, this.installation) && await this.namespaceCanBeDeleted()) {
        await this.deleteWithUid(namespace);
        deleted.push(resourceIdentity(namespace));
      } else if (namespace) {
        preserved.push(resourceIdentity(namespace));
      }
    }
    return {
      deleted: [...new Set(deleted)],
      preserved: [...new Set(preserved)],
      skipped: [...new Set(skipped)],
    };
  }

  private async assertNoReferencedOwnedClaims(inventory: KubernetesObject): Promise<void> {
    const options = parseRecord((inventory as Record<string, any>).data?.options);
    const cleanupOwnerId = typeof options.cleanupOwnerId === 'string' ? options.cleanupOwnerId : undefined;
    const claims = await this.list('v1', 'PersistentVolumeClaim', this.namespace);
    const pods = await this.list('v1', 'Pod', this.namespace);
    const referenced = claims.filter(claim => {
      const managed = isAoClaim(claim)
        && (hasInstallationOwnership(claim, this.installation)
          || Boolean(cleanupOwnerId && claim.metadata?.annotations?.[CLEANUP_OWNER] === cleanupOwnerId));
      return managed && pods.some(pod => ((pod as Record<string, any>).spec?.volumes ?? [])
        .some((volume: any) => volume.persistentVolumeClaim?.claimName === claim.metadata?.name));
    });
    if (referenced.length > 0) {
      throw new Error(`Refusing to purge PVCs still referenced by Pods: ${referenced.map(resourceIdentity).join(', ')}`);
    }
  }

  private async purgeCrds(deleted: string[], preserved: string[], skipped: string[]): Promise<void> {
    const definitions = [
      { name: 'conversationroutes.agentorchestrator.io', apiVersion: 'agentorchestrator.io/v1alpha1', kind: 'ConversationRoute' },
      { name: 'opencodeinstances.agentorchestrator.io', apiVersion: 'agentorchestrator.io/v1alpha1', kind: 'OpencodeInstance' },
    ];
    for (const definition of definitions) {
      const header = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: definition.name } };
      const crd = await this.readOptional(header);
      if (!crd) continue;
      const identity = resourceIdentity(crd);
      if (!hasInstallationOwnership(crd, this.installation)) {
        skipped.push(identity);
        continue;
      }
      const remaining = await this.list(definition.apiVersion, definition.kind).catch(() => [header]);
      if (remaining.length > 0) {
        if (!preserved.includes(identity)) preserved.push(identity);
        continue;
      }
      await this.deleteWithUid(crd);
      const preservedIndex = preserved.indexOf(identity);
      if (preservedIndex >= 0) preserved.splice(preservedIndex, 1);
      deleted.push(identity);
    }
  }

  private async purgeConversationData(inventory: KubernetesObject, deleted: string[], skipped: string[]): Promise<void> {
    const options = parseRecord((inventory as Record<string, any>).data?.options);
    const cleanupOwnerId = typeof options.cleanupOwnerId === 'string' ? options.cleanupOwnerId : undefined;
    const claims = await this.list('v1', 'PersistentVolumeClaim', this.namespace);
    const pods = await this.list('v1', 'Pod', this.namespace);
    for (const claim of claims) {
      if (!isAoClaim(claim) || !cleanupOwnerId || claim.metadata?.annotations?.[CLEANUP_OWNER] !== cleanupOwnerId) {
        if (isAoClaim(claim)) skipped.push(resourceIdentity(claim));
        continue;
      }
      const referenced = pods.some(pod => ((pod as Record<string, any>).spec?.volumes ?? [])
        .some((volume: any) => volume.persistentVolumeClaim?.claimName === claim.metadata?.name));
      if (referenced) {
        skipped.push(resourceIdentity(claim));
        continue;
      }
      await this.deleteWithUid(claim);
      deleted.push(resourceIdentity(claim));
    }

    const instances = await this.list('agentorchestrator.io/v1alpha1', 'OpencodeInstance', this.namespace).catch(() => []);
    const ownedNames = new Set(instances
      .filter(instance => !cleanupOwnerId || instance.metadata?.annotations?.[CLEANUP_OWNER] === cleanupOwnerId)
      .map(instance => instance.metadata?.name));
    const routes = await this.list('agentorchestrator.io/v1alpha1', 'ConversationRoute', this.namespace).catch(() => []);
    for (const resource of [...routes.filter(route => ownedNames.has(route.metadata?.name)), ...instances.filter(instance => ownedNames.has(instance.metadata?.name))]) {
      await this.deleteWithUid(resource);
      deleted.push(resourceIdentity(resource));
    }
  }

  private async namespaceCanBeDeleted(): Promise<boolean> {
    const kinds: Array<[string, string]> = [
      ['v1', 'Pod'], ['v1', 'Service'], ['v1', 'Secret'], ['v1', 'ConfigMap'], ['v1', 'PersistentVolumeClaim'], ['v1', 'ServiceAccount'],
      ['apps/v1', 'Deployment'], ['rbac.authorization.k8s.io/v1', 'Role'], ['rbac.authorization.k8s.io/v1', 'RoleBinding'],
      ['networking.k8s.io/v1', 'Ingress'],
    ];
    for (const [apiVersion, kind] of kinds) {
      const resources = await this.list(apiVersion, kind, this.namespace).catch(() => []);
      const foreign = resources.some(resource => !isKubernetesDefault(resource) && !hasInstallationOwnership(resource, this.installation));
      if (foreign) return false;
    }
    return true;
  }

  private async waitForDeployment(resource: KubernetesObject, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.api.read(asHeader(resource));
      if (deploymentReady(current)) return;
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    throw new Error(`Timed out waiting for Deployment ${resource.metadata?.name}`);
  }

  private async readInventory(): Promise<KubernetesObject | undefined> {
    return this.readOptional({
      apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'agent-orchestrator-installation', namespace: this.namespace },
    });
  }

  private async readOptional(resource: KubernetesObject): Promise<KubernetesObject | undefined> {
    try {
      return await this.api.read(asHeader(resource));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private async list(apiVersion: string, kind: string, namespace?: string): Promise<KubernetesObject[]> {
    const result = await this.api.list(apiVersion, kind, namespace);
    return result.items ?? [];
  }

  private async deleteWithUid(resource: KubernetesObject): Promise<void> {
    const body: V1DeleteOptions = resource.metadata?.uid ? { preconditions: { uid: resource.metadata.uid } } : {};
    await this.api.delete(resource, undefined, undefined, undefined, undefined, 'Foreground', body);
  }

  private fieldManager(): string {
    return `${FIELD_MANAGER_PREFIX}/${this.installation}`.slice(0, 128);
  }
}

function forKubernetesClient(resource: KubernetesObject): KubernetesObject {
  if (resource.kind !== 'CustomResourceDefinition') return resource;
  return renameEnumFields(structuredClone(resource)) as KubernetesObject;
}

function renameEnumFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renameEnumFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key === 'enum' ? '_enum' : key,
    renameEnumFields(item),
  ]));
}

function identityHeader(identity: string): KubernetesObject {
  const first = identity.indexOf(':');
  const second = identity.indexOf(':', first + 1);
  if (first < 1 || second < 0) throw new Error(`Invalid inventory identity: ${identity}`);
  const apiVersion = identity.slice(0, first);
  const kind = identity.slice(first + 1, second);
  const location = identity.slice(second + 1);
  const slash = location.indexOf('/');
  return {
    apiVersion,
    kind,
    metadata: slash >= 0
      ? { namespace: location.slice(0, slash), name: location.slice(slash + 1) }
      : { name: location },
  };
}

function asHeader(resource: KubernetesObject): { apiVersion: string; kind: string; metadata: { name: string; namespace?: string } } {
  if (!resource.apiVersion || !resource.kind || !resource.metadata?.name) throw new Error('Kubernetes resource identity is incomplete');
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    metadata: {
      name: resource.metadata.name,
      ...(resource.metadata.namespace ? { namespace: resource.metadata.namespace } : {}),
    },
  };
}

function assertAdoptable(current: KubernetesObject, desired: KubernetesObject): void {
  if (current.apiVersion !== desired.apiVersion || current.kind !== desired.kind || current.metadata?.name !== desired.metadata?.name) {
    throw new Error(`Resource ${resourceIdentity(current)} is not compatible with the desired installation`);
  }
  if (current.kind === 'Deployment') {
    const currentSelector = stableObject((current as Record<string, any>).spec?.selector ?? {});
    const desiredSelector = stableObject((desired as Record<string, any>).spec?.selector ?? {});
    if (currentSelector !== desiredSelector) throw new Error(`Deployment ${current.metadata?.name} has an incompatible selector`);
  }
  if (current.kind === 'Service') {
    const currentSelector = stableObject((current as Record<string, any>).spec?.selector ?? {});
    const desiredSelector = stableObject((desired as Record<string, any>).spec?.selector ?? {});
    if (currentSelector !== desiredSelector) throw new Error(`Service ${current.metadata?.name} has an incompatible selector`);
  }
  if (current.kind === 'PersistentVolumeClaim') {
    const currentSpec = (current as Record<string, any>).spec ?? {};
    const desiredSpec = (desired as Record<string, any>).spec ?? {};
    const currentStorage = String(currentSpec.resources?.requests?.storage ?? '');
    const desiredStorage = String(desiredSpec.resources?.requests?.storage ?? '');
    if (currentStorage !== desiredStorage || stableObject(currentSpec.accessModes ?? []) !== stableObject(desiredSpec.accessModes ?? [])) {
      throw new Error(`PersistentVolumeClaim ${current.metadata?.name} has incompatible storage or access modes`);
    }
    if (desiredSpec.storageClassName && currentSpec.storageClassName !== desiredSpec.storageClassName) {
      throw new Error(`PersistentVolumeClaim ${current.metadata?.name} has an incompatible storage class`);
    }
  }
  if (current.kind === 'CustomResourceDefinition') {
    const currentSpec = (current as Record<string, any>).spec ?? {};
    const desiredSpec = (desired as Record<string, any>).spec ?? {};
    const currentIdentity = {
      group: currentSpec.group,
      scope: currentSpec.scope,
      names: currentSpec.names,
      versions: (currentSpec.versions ?? []).map((version: any) => ({ name: version.name, served: version.served, storage: version.storage })),
    };
    const desiredIdentity = {
      group: desiredSpec.group,
      scope: desiredSpec.scope,
      names: desiredSpec.names,
      versions: (desiredSpec.versions ?? []).map((version: any) => ({ name: version.name, served: version.served, storage: version.storage })),
    };
    if (stableObject(currentIdentity) !== stableObject(desiredIdentity)) {
      throw new Error(`CustomResourceDefinition ${current.metadata?.name} has an incompatible API identity`);
    }
  }
}

function stableObject(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableObject).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableObject(item)}`)
    .join(',')}}`;
}

function deploymentReady(resource: KubernetesObject): boolean {
  const object = resource as Record<string, any>;
  const desired = object.spec?.replicas ?? 1;
  return object.status?.observedGeneration === object.metadata?.generation
    && (object.status?.availableReplicas ?? 0) >= desired;
}

function deploymentDetail(resource: KubernetesObject): string {
  const object = resource as Record<string, any>;
  const image = object.spec?.template?.spec?.containers?.[0]?.image ?? 'unknown image';
  return `${object.status?.availableReplicas ?? 0}/${object.spec?.replicas ?? 1} available, ${image}`;
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]')) as unknown;
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isAoClaim(resource: KubernetesObject): boolean {
  return resource.kind === 'PersistentVolumeClaim'
    && resource.metadata?.labels?.[PART_OF_LABEL] === 'agent-orchestrator'
    && Boolean(resource.metadata?.labels?.[CONVERSATION_LABEL] || resource.metadata?.name === 'ao-workspace');
}

function isKubernetesDefault(resource: KubernetesObject): boolean {
  return resource.metadata?.name === 'default' || resource.metadata?.name === 'kube-root-ca.crt';
}

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 300);
  return 'Unknown Kubernetes API error';
}
