/* eslint-disable @typescript-eslint/no-explicit-any */
import { writeFileSync } from 'node:fs';
import { Command, Option } from 'commander';
import { loadConfig } from '../config-loader.js';
import type { AgentOrchestratorConfig } from '../config-loader.js';
import { K8sInstallationManager } from './k8s-manager.js';
import { renderK8sInstallation, type K8sRenderOptions } from './k8s-renderer.js';
import { CliActionError } from './operational.js';
import { printValue } from './output.js';

interface K8sCliOptions {
  kubeconfig?: string;
  context?: string;
  namespace: string;
  installation: string;
  image: string;
  configFile?: string;
  existingConfigSecret?: string;
  workspaceSize: string;
  conversationStorage: string;
  storageClass?: string;
  operator: boolean;
  operatorExecute?: boolean;
  operatorApiKeySecret?: string;
  ingressHost?: string;
  ingressClass: string;
  tlsSecret?: string;
  serviceMonitor?: boolean;
  cleanupOwnerId?: string;
  rolloutTimeout: string;
  output?: string;
  purgeData?: boolean;
  confirm?: boolean;
  json?: boolean;
  inlineConfig?: AgentOrchestratorConfig;
}

export function registerK8sCommands(program: Command, version: string): void {
  const k8s = program.command('k8s').description('Render and manage AgentOrchestrator Kubernetes components');
  addK8sOptions(k8s, version);

  k8s.command('render')
    .description('Render deterministic Kubernetes manifests')
    .option('-o, --output <path>', 'Write YAML to a file instead of stdout')
    .action(k8sAction(async (options, command) => {
      const all = command.optsWithGlobals() as K8sCliOptions;
      const rendered = renderK8sInstallation(buildRenderOptions(all, version, true));
      if (options.output) {
        writeFileSync(options.output, rendered.yaml, { encoding: 'utf8', mode: 0o600 });
        printValue({ output: options.output, resources: rendered.resources.length }, { json: all.json === true });
      } else {
        process.stdout.write(rendered.yaml);
      }
    }));

  k8s.command('install')
    .description('Install AgentOrchestrator with server-side apply')
    .option('--rollout-timeout <ms>', 'Deployment readiness timeout', '300000')
    .action(k8sAction(async (options, command) => {
      const all = { ...(command.optsWithGlobals() as K8sCliOptions), ...options };
      const manager = managerFor(all);
      const external = all.existingConfigSecret
        ? await manager.validateExternalConfigSecret(all.existingConfigSecret)
        : {};
      const rendered = renderK8sInstallation(buildRenderOptions({ ...all, ...external }, version, true));
      printValue(await manager.apply(rendered, positiveMs(all.rolloutTimeout)), { json: all.json === true });
    }));

  k8s.command('upgrade')
    .description('Upgrade an owned installation using its recorded options')
    .option('--rollout-timeout <ms>', 'Deployment readiness timeout', '300000')
    .action(k8sAction(async (options, command) => {
      const requested = { ...(command.optsWithGlobals() as K8sCliOptions), ...options };
      const manager = managerFor(requested);
      const status = await manager.status();
      if (!status.found || !status.options) throw new CliActionError('Installation inventory not found', 4);
      const all = mergeInventoryOptions(requested, status.options, command);
      const configSecretName = typeof status.options.configSecretName === 'string'
        ? status.options.configSecretName
        : undefined;
      const configSource = status.options.configSource;
      let external: Partial<K8sCliOptions> = {};
      if (all.existingConfigSecret) {
        external = await manager.validateExternalConfigSecret(all.existingConfigSecret);
      } else if (!all.configFile && configSecretName) {
        const saved = await manager.validateExternalConfigSecret(configSecretName);
        if (configSource === 'owned-secret') external = { ...saved, inlineConfig: saved.config };
        else external = { ...saved, existingConfigSecret: configSecretName };
      }
      const rendered = renderK8sInstallation(buildRenderOptions({ ...all, ...external }, version, true));
      printValue(await manager.apply(rendered, positiveMs(all.rolloutTimeout)), { json: all.json === true });
    }));

  k8s.command('status').description('Show installation and resource readiness')
    .action(k8sAction(async (_options, command) => {
      const all = command.optsWithGlobals() as K8sCliOptions;
      const status = await managerFor(all).status();
      printValue(status, { json: all.json === true });
      if (!status.found) process.exitCode = 4;
    }));

  k8s.command('doctor').description('Run read-only cluster and installation diagnostics')
    .action(k8sAction(async (_options, command) => {
      const all = command.optsWithGlobals() as K8sCliOptions;
      const report = await managerFor(all).doctor();
      printValue(report, { json: all.json === true });
      if (!report.healthy) process.exitCode = 1;
    }));

  k8s.command('adopt').description('Adopt compatible legacy resources')
    .requiredOption('--confirm', 'Confirm ownership metadata mutation')
    .action(k8sAction(async (_options, command) => {
      const all = command.optsWithGlobals() as K8sCliOptions;
      const manager = managerFor(all);
      const external = all.existingConfigSecret
        ? await manager.validateExternalConfigSecret(all.existingConfigSecret)
        : {};
      const rendered = renderK8sInstallation(buildRenderOptions({ ...all, ...external }, version, true));
      printValue(await manager.adopt(rendered), { json: all.json === true });
    }));

  k8s.command('uninstall').description('Remove owned Kubernetes components')
    .requiredOption('--confirm', 'Confirm uninstall')
    .option('--purge-data', 'Also remove verified owned persistent data')
    .action(k8sAction(async (options, command) => {
      const all = { ...(command.optsWithGlobals() as K8sCliOptions), ...options };
      const manager = managerFor(all);
      const before = await manager.status();
      const report = await manager.uninstall(options.purgeData === true);
      printValue({ preview: before.resources.map(resource => resource.identity), ...report }, { json: all.json === true });
    }));
}

function addK8sOptions(command: Command, version: string): void {
  command
    .option('--kubeconfig <path>', 'Kubeconfig path')
    .option('--context <name>', 'Kubeconfig context')
    .option('--namespace <name>', 'Installation namespace', 'ao-instances')
    .option('--installation <id>', 'Installation identity', 'agent-orchestrator')
    .option('--image <image>', 'AgentOrchestrator image', `luberserker/agent-orchestrator:${version}`)
    .addOption(new Option('--config-file <path>').conflicts('existingConfigSecret'))
    .addOption(new Option('--existing-config-secret <name>').conflicts('configFile'))
    .option('--workspace-size <quantity>', 'Workspace PVC size', '20Gi')
    .option('--conversation-storage <quantity>', 'Conversation PVC size', '10Gi')
    .option('--storage-class <name>', 'PVC storage class')
    .option('--no-operator', 'Do not install the placement operator')
    .option('--operator-execute', 'Enable live migration execution')
    .option('--operator-api-key-secret <name:key>', 'Secret key reference for operator callbacks')
    .option('--ingress-host <host>', 'Enable Ingress for this host')
    .option('--ingress-class <class>', 'Ingress class', 'traefik')
    .option('--tls-secret <name>', 'Ingress TLS Secret')
    .option('--service-monitor', 'Install a Prometheus ServiceMonitor')
    .option('--cleanup-owner-id <id>', 'Cleanup owner for externally managed rendered configs');
}

function buildRenderOptions(options: K8sCliOptions, version: string, requireConfig: boolean): K8sRenderOptions {
  if (requireConfig && !options.configFile && !options.existingConfigSecret && !options.inlineConfig) {
    throw new CliActionError('Exactly one of --config-file or --existing-config-secret is required', 2);
  }
  const config = options.configFile ? loadConfig(options.configFile) : options.inlineConfig;
  const secretRef = options.operatorApiKeySecret ? parseSecretRef(options.operatorApiKeySecret) : undefined;
  return {
    namespace: options.namespace,
    installation: options.installation,
    version,
    image: options.image,
    ...(config ? { config } : {}),
    ...(options.existingConfigSecret ? { existingConfigSecret: options.existingConfigSecret } : {}),
    workspaceSize: options.workspaceSize,
    conversationStorage: options.conversationStorage,
    ...(options.storageClass ? { storageClass: options.storageClass } : {}),
    operator: options.operator !== false,
    operatorExecute: options.operatorExecute === true,
    ...(secretRef ? { operatorApiKeySecret: secretRef } : {}),
    ...(options.ingressHost ? { ingressHost: options.ingressHost } : {}),
    ingressClass: options.ingressClass,
    ...(options.tlsSecret ? { tlsSecret: options.tlsSecret } : {}),
    serviceMonitor: options.serviceMonitor === true,
    ...(options.cleanupOwnerId ? { cleanupOwnerId: options.cleanupOwnerId } : {}),
  };
}

function mergeInventoryOptions(
  requested: K8sCliOptions,
  inventory: Record<string, unknown>,
  command: Command,
): K8sCliOptions {
  const result = { ...requested };
  const keys: Array<keyof Pick<K8sCliOptions,
    'image' | 'workspaceSize' | 'conversationStorage' | 'storageClass' | 'operator' | 'operatorExecute'
    | 'operatorApiKeySecret' | 'ingressHost' | 'ingressClass' | 'tlsSecret' | 'serviceMonitor' | 'cleanupOwnerId'>> = [
      'image', 'workspaceSize', 'conversationStorage', 'storageClass', 'operator', 'operatorExecute',
      'operatorApiKeySecret', 'ingressHost', 'ingressClass', 'tlsSecret', 'serviceMonitor', 'cleanupOwnerId',
    ];
  for (const key of keys) {
    if (k8sOptionWasSpecified(command, key) || inventory[key] === undefined) continue;
    (result as Record<string, unknown>)[key] = inventory[key];
  }
  return result;
}

function k8sOptionWasSpecified(command: Command, key: string): boolean {
  const parent = command.parent;
  return parent?.getOptionValueSource(key) === 'cli';
}

function managerFor(options: K8sCliOptions): K8sInstallationManager {
  return new K8sInstallationManager(
    { ...(options.kubeconfig ? { kubeconfig: options.kubeconfig } : {}), ...(options.context ? { context: options.context } : {}) },
    options.namespace,
    options.installation,
  );
}

function parseSecretRef(value: string): { name: string; key: string } {
  const separator = value.indexOf(':');
  if (separator < 1 || separator === value.length - 1) throw new CliActionError('Expected --operator-api-key-secret <name:key>', 2);
  return { name: value.slice(0, separator), key: value.slice(separator + 1) };
}

function positiveMs(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new CliActionError(`Invalid timeout: ${value}`, 2);
  return parsed;
}

function k8sAction(action: (...args: any[]) => Promise<void>): (...args: any[]) => Promise<void> {
  return async (...args: any[]) => {
    try {
      await action(...args);
    } catch (error) {
      if (error instanceof CliActionError) throw error;
      throw new CliActionError(
        error instanceof Error ? error.message : 'Kubernetes operation failed',
        k8sExitCode(error),
      );
    }
  };
}

function k8sExitCode(error: unknown): number {
  const status = (error as { statusCode?: number; code?: number; response?: { statusCode?: number } })?.statusCode
    ?? (error as { code?: number })?.code
    ?? (error as { response?: { statusCode?: number } })?.response?.statusCode;
  if (status === 404) return 4;
  if (status === 409) return 5;
  const message = error instanceof Error ? error.message : '';
  return /\b(?:foreign resource|conflict|still referenced)\b/i.test(message) ? 5 : 1;
}
