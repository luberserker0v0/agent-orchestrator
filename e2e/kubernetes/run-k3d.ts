import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '../..');
const namespace = 'ao-instances';
const suffix = randomBytes(4).toString('hex');
const clusterName = `ao-xnode-${suffix}`;
const contextName = `k3d-${clusterName}`;
const sharedVolume = `ao-e2e-shared-${suffix}`;
const orchestratorImage = `agent-orchestrator:e2e-${suffix}`;
const opencodeSourceImage = process.env.K3D_E2E_OPENCODE_IMAGE ?? 'ghcr.io/anomalyco/opencode:1.17.8';
const opencodeImage = `opencode:e2e-${suffix}`;
const k3sImage = process.env.K3D_E2E_K3S_IMAGE ?? 'rancher/k3s:v1.31.5-k3s1';
const reconcileIntervalMs = 1_000;
const cleanupOwnerId = `k3d-e2e-${suffix}`;
const orphanGracePeriodMs = 1_000;
const keepResources = process.env.K3D_E2E_KEEP === '1';
const activeChildren = new Set<ChildProcess>();

let tempDirectory: string | undefined;
let kubeconfigPath: string | undefined;
let volumeCreated = false;
let clusterAttempted = false;
let imageBuilt = false;
let opencodeImageBuilt = false;
let cleanupPromise: Promise<void> | undefined;

interface RunOptions {
  capture?: boolean;
  env?: NodeJS.ProcessEnv;
  input?: string;
  label?: string;
  timeoutMs?: number;
  tolerateFailure?: boolean;
  expectFailure?: boolean;
}

interface NodeList {
  items: Array<{
    metadata: {
      name: string;
      labels?: Record<string, string>;
    };
  }>;
}

interface ClusterSummary {
  name: string;
}

interface DockerMount {
  Type?: string;
  Name?: string;
  Destination?: string;
}

function parseRepeat(): number {
  const value = Number(process.env.K3D_E2E_REPEAT ?? '1');
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`K3D_E2E_REPEAT must be a positive integer, got ${process.env.K3D_E2E_REPEAT}`);
  }
  return value;
}

async function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
  const label = options.label ?? `${command} ${args.join(' ')}`;
  process.stdout.write(`[k3d-e2e] ${label}\n`);
  const capture = options.capture ?? false;
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    windowsHide: true,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
  });
  activeChildren.add(child);

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  if (options.input !== undefined) child.stdin?.end(options.input);

  return new Promise<string>((resolvePromise, reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 180_000);
    child.once('error', (err) => {
      clearTimeout(timeout);
      activeChildren.delete(child);
      reject(err);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      activeChildren.delete(child);
      if (options.expectFailure) {
        if (code === 0) {
          reject(new Error(`${label} unexpectedly succeeded`));
          return;
        }
        resolvePromise((stderr || stdout).trim());
        return;
      }
      if (code === 0 || options.tolerateFailure) {
        resolvePromise(stdout.trim());
        return;
      }
      const detail = capture ? `\n${stderr || stdout}` : '';
      reject(new Error(`${label} failed (${timedOut ? 'timeout' : `exit ${code ?? signal}`})${detail}`));
    });
  });
}

function clusterEnv(): NodeJS.ProcessEnv {
  if (!kubeconfigPath) throw new Error('isolated kubeconfig has not been created');
  return { KUBECONFIG: kubeconfigPath };
}

function kubectl(args: string[], options: RunOptions = {}): Promise<string> {
  return run('kubectl', ['--context', contextName, ...args], {
    ...options,
    env: { ...clusterEnv(), ...(options.env ?? {}) },
  });
}

async function applyFile(relativePath: string): Promise<void> {
  await kubectl(['apply', '-f', resolvePath(repoRoot, relativePath)], {
    label: `apply ${relativePath}`,
  });
}

async function aorK8s(args: string[], label: string): Promise<string> {
  if (!kubeconfigPath) throw new Error('isolated kubeconfig has not been created');
  return run(process.execPath, [
    resolvePath(repoRoot, 'bin/aor.js'),
    '--json',
    'k8s',
    '--kubeconfig', kubeconfigPath,
    '--context', contextName,
    '--namespace', namespace,
    '--installation', 'k3d-e2e',
    ...args,
  ], { capture: true, label, timeoutMs: 300_000 });
}

async function aorK8sMustFail(args: string[], label: string): Promise<string> {
  if (!kubeconfigPath) throw new Error('isolated kubeconfig has not been created');
  return run(process.execPath, [
    resolvePath(repoRoot, 'bin/aor.js'),
    '--json',
    'k8s',
    '--kubeconfig', kubeconfigPath,
    '--context', contextName,
    '--namespace', namespace,
    '--installation', 'k3d-e2e',
    ...args,
  ], { capture: true, expectFailure: true, label, timeoutMs: 300_000 });
}

async function verifySharedMount(nodeName: string): Promise<void> {
  const raw = await run('docker', ['inspect', nodeName, '--format', '{{json .Mounts}}'], {
    capture: true,
    label: `verify /shared mount on ${nodeName}`,
  });
  const mounts = JSON.parse(raw) as DockerMount[];
  const mounted = mounts.some((mount) =>
    mount.Type === 'volume'
    && mount.Name === sharedVolume
    && mount.Destination === '/shared');
  if (!mounted) throw new Error(`${nodeName} does not mount Docker volume ${sharedVolume} at /shared`);
}

async function diagnostics(): Promise<void> {
  if (!kubeconfigPath) return;
  process.stderr.write('[k3d-e2e] failure diagnostics follow\n');
  const commands: Array<{ label: string; args: string[] }> = [
    { label: 'nodes', args: ['get', 'nodes', '-o', 'wide'] },
    { label: 'workloads', args: ['-n', namespace, 'get', 'pods,services,persistentvolumeclaims,opencodeinstances,conversationroutes', '-o', 'wide'] },
    { label: 'persistent volumes', args: ['get', 'persistentvolumes', '-o', 'wide'] },
    { label: 'namespace events', args: ['-n', namespace, 'get', 'events', '--sort-by=.lastTimestamp'] },
    { label: 'orchestrator logs', args: ['-n', namespace, 'logs', 'deployment/agent-orchestrator', '--tail=200'] },
    { label: 'placement controller logs', args: ['-n', namespace, 'logs', 'deployment/placement-controller', '--tail=200'] },
  ];
  for (const command of commands) {
    await kubectl(command.args, {
      label: `diagnostic: ${command.label}`,
      timeoutMs: 30_000,
      tolerateFailure: true,
    });
  }
}

async function cleanup(): Promise<void> {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (keepResources) {
      process.stdout.write(`[k3d-e2e] keeping cluster ${clusterName}, volume ${sharedVolume}, image ${orchestratorImage}, and ${tempDirectory ?? 'temporary files'}\n`);
      return;
    }
    if (clusterAttempted) {
      await run('k3d', ['cluster', 'delete', clusterName], {
        label: `delete cluster ${clusterName}`,
        timeoutMs: 180_000,
        tolerateFailure: true,
      });
    }
    if (volumeCreated) {
      await run('docker', ['volume', 'rm', sharedVolume], {
        label: `delete shared volume ${sharedVolume}`,
        tolerateFailure: true,
      });
    }
    if (imageBuilt) {
      await run('docker', ['image', 'rm', orchestratorImage], {
        label: `delete test image ${orchestratorImage}`,
        tolerateFailure: true,
      });
    }
    if (opencodeImageBuilt) {
      await run('docker', ['image', 'rm', opencodeImage], {
        label: `delete test image ${opencodeImage}`,
        tolerateFailure: true,
      });
    }
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });

    const clusters = JSON.parse(await run('k3d', ['cluster', 'list', '-o', 'json'], {
      capture: true,
      label: 'verify test cluster cleanup',
    })) as ClusterSummary[];
    const remainingVolume = volumeCreated
      ? await run('docker', ['volume', 'ls', '--filter', `name=^${sharedVolume}$`, '--format', '{{.Name}}'], {
          capture: true,
          label: 'verify shared volume cleanup',
        })
      : '';
    const remainingOrchestratorImage = imageBuilt
      ? await run('docker', ['image', 'ls', '--filter', `reference=${orchestratorImage}`, '--format', '{{.Repository}}:{{.Tag}}'], {
          capture: true,
          label: 'verify orchestrator image cleanup',
        })
      : '';
    const remainingOpencodeImage = opencodeImageBuilt
      ? await run('docker', ['image', 'ls', '--filter', `reference=${opencodeImage}`, '--format', '{{.Repository}}:{{.Tag}}'], {
          capture: true,
          label: 'verify OpenCode image cleanup',
        })
      : '';
    const leaks = [
      clusters.some((cluster) => cluster.name === clusterName) ? `cluster ${clusterName}` : '',
      remainingVolume === sharedVolume ? `volume ${sharedVolume}` : '',
      remainingOrchestratorImage === orchestratorImage ? `image ${orchestratorImage}` : '',
      remainingOpencodeImage === opencodeImage ? `image ${opencodeImage}` : '',
    ].filter(Boolean);
    if (leaks.length > 0) throw new Error(`k3d E2E cleanup left resources behind: ${leaks.join(', ')}`);
  })();
  return cleanupPromise;
}

async function prepareCluster(): Promise<{ sourceNode: string; targetNode: string; apiKey: string; configPath: string }> {
  tempDirectory = await mkdtemp(join(tmpdir(), 'ao-k3d-e2e-'));
  kubeconfigPath = join(tempDirectory, 'kubeconfig.yaml');

  const orchestratorDockerfile = join(tempDirectory, 'Dockerfile.agent-orchestrator');
  const orchestratorDockerignore = `${orchestratorDockerfile}.dockerignore`;
  await writeFile(orchestratorDockerfile, await readFile(resolvePath(repoRoot, 'Dockerfile.template')));
  await writeFile(
    orchestratorDockerignore,
    `${await readFile(resolvePath(repoRoot, '.dockerignore'), 'utf8')}\nconfig/agentorchestrator.json\nconfig/canonical-opencode.json\n`,
    { encoding: 'utf8' },
  );

  await run('docker', ['build', '--provenance=false', '--file', orchestratorDockerfile, '--tag', orchestratorImage, '.'], {
    label: `build ${orchestratorImage}`,
    timeoutMs: 600_000,
  });
  imageBuilt = true;
  await run('docker', [
    'run', '--rm', '--entrypoint', 'sh', orchestratorImage,
    '-c', 'test ! -e /app/config/agentorchestrator.json && test ! -e /app/config/canonical-opencode.json',
  ], {
    label: 'verify local configuration is absent from the test image',
  });
  await run('docker', ['pull', opencodeSourceImage], {
    label: `pull ${opencodeSourceImage}`,
    timeoutMs: 600_000,
  });
  const opencodeDockerfile = join(tempDirectory, 'Dockerfile.opencode');
  await writeFile(
    opencodeDockerfile,
    'ARG SOURCE_IMAGE=ghcr.io/anomalyco/opencode:1.17.8\nFROM ${SOURCE_IMAGE}\n',
    { encoding: 'utf8' },
  );
  await run('docker', [
    'build', '--provenance=false',
    '--file', opencodeDockerfile,
    '--build-arg', `SOURCE_IMAGE=${opencodeSourceImage}`,
    '--tag', opencodeImage,
    '.',
  ], {
    label: `flatten ${opencodeSourceImage} as ${opencodeImage}`,
    timeoutMs: 600_000,
  });
  opencodeImageBuilt = true;
  await run('docker', ['volume', 'create', sharedVolume], {
    label: `create shared volume ${sharedVolume}`,
    capture: true,
  });
  volumeCreated = true;

  clusterAttempted = true;
  await run('k3d', [
    'cluster', 'create', clusterName,
    '--image', k3sImage,
    '--servers', '1',
    '--agents', '2',
    '--no-lb',
    '--volume', `${sharedVolume}:/shared@all`,
    '--k3s-arg', '--disable=traefik@server:0',
    '--kubeconfig-update-default=false',
    '--kubeconfig-switch-context=false',
    '--wait',
    '--timeout', '180s',
  ], {
    label: `create cluster ${clusterName}`,
    timeoutMs: 300_000,
  });

  const kubeconfig = await run('k3d', ['kubeconfig', 'get', clusterName], {
    capture: true,
    label: `write isolated kubeconfig for ${clusterName}`,
  });
  await writeFile(kubeconfigPath, `${kubeconfig}\n`, { encoding: 'utf8', mode: 0o600 });

  await run('k3d', ['image', 'import', orchestratorImage, '--cluster', clusterName, '--mode', 'direct'], {
    label: 'import orchestrator image into every k3d node',
    timeoutMs: 600_000,
  });
  await run('k3d', ['image', 'import', opencodeImage, '--cluster', clusterName, '--mode', 'direct'], {
    label: 'import OpenCode image into every k3d node',
    timeoutMs: 600_000,
  });

  const nodes = JSON.parse(await kubectl(['get', 'nodes', '-o', 'json'], {
    capture: true,
    label: 'discover worker nodes',
  })) as NodeList;
  const workers = nodes.items
    .filter((node) => {
      const labels = node.metadata.labels ?? {};
      return !('node-role.kubernetes.io/control-plane' in labels) && !('node-role.kubernetes.io/master' in labels);
    })
    .map((node) => node.metadata.name)
    .sort();
  if (workers.length < 2) throw new Error(`expected two worker nodes, found ${workers.join(', ') || 'none'}`);
  const [sourceNode, targetNode] = workers;
  await verifySharedMount(sourceNode);
  await verifySharedMount(targetNode);

  const apiKey = randomBytes(32).toString('base64url');
  const config = {
    server: {
      port: 8080,
      host: '0.0.0.0',
      shutdownTimeoutMs: 15_000,
      apiKeys: [{ key: apiKey, role: 'admin', name: 'k3d-e2e' }],
      rbac: { enabled: true },
    },
    websocket: { heartbeatIntervalMs: 30_000, idleTimeoutMs: 600_000 },
    cleanup: {
      ownerId: cleanupOwnerId,
      sweepIntervalMs: 3_600_000,
      orphanedData: { enabled: true, gracePeriodMs: orphanGracePeriodMs },
    },
    orchestrator: {
      maxInstances: 4,
      idleTimeoutMs: 0,
      idleSweepIntervalMs: 60_000,
      portRange: { start: 30_000, end: 30_020, allowDynamicFallback: true },
      defaultAgentType: 'opencode-k8s',
      runtimes: [{
        id: 'opencode-k8s',
        type: 'kubernetes',
        config: {
          image: opencodeImage,
          namespace,
          nodeName: sourceNode,
          sessionMode: 'xdg',
          pvcStorage: '64Mi',
          podReadyTimeoutMs: 30_000,
          resources: {
            requests: { cpu: '50m', memory: '128Mi' },
            limits: { cpu: '500m', memory: '512Mi' },
          },
        },
      }],
      healthCheck: { retries: 20, intervalMs: 250, clientTimeoutMs: 2_000 },
      sse: { enabled: false, reconnectMaxAttempts: 1, reconnectBaseMs: 100, filterHeartbeat: true },
    },
    workspace: {
      basePath: '/data/workspace',
      enforceCanonicalConfig: false,
      maxSizeBytes: 52_428_800,
      storage: { type: 'local' },
    },
    cluster: {
      enabled: true,
      namespace,
      heartbeatIntervalMs: 0,
      quotaFailureThreshold: 2,
      advertiseBaseUrl: `http://agent-orchestrator.${namespace}.svc.cluster.local:8080`,
    },
  };
  const configPath = join(tempDirectory, 'agentorchestrator.json');
  await writeFile(configPath, JSON.stringify(config), { encoding: 'utf8', mode: 0o600 });

  const manifests = [
    'k8s/namespace.yaml',
    'k8s/crd/opencodeinstances.yaml',
    'k8s/crd/conversationroutes.yaml',
    'k8s/orchestrator/serviceaccount.yaml',
    'k8s/orchestrator/role.yaml',
    'k8s/orchestrator/rolebinding.yaml',
    'k8s/orchestrator/workspace-pvc.yaml',
    'k8s/orchestrator/service.yaml',
    'k8s/operator/serviceaccount.yaml',
    'k8s/operator/role.yaml',
    'k8s/operator/rolebinding.yaml',
    'k8s/operator/clusterrole.yaml',
  ];
  for (const manifest of manifests) await applyFile(manifest);
  await kubectl(['wait', '--for=condition=Established', '--timeout=60s', 'crd/opencodeinstances.agentorchestrator.io', 'crd/conversationroutes.agentorchestrator.io'], {
    label: 'wait for custom resource definitions',
  });
  await kubectl([
    '-n', namespace, 'create', 'secret', 'generic', 'operator-api-key',
    `--from-literal=key=${apiKey}`,
  ], { label: 'create external operator API key Secret' });

  const installationOptions = [
    '--config-file', configPath,
    '--image', orchestratorImage,
    '--workspace-size', '20Gi',
    '--conversation-storage', '64Mi',
    '--operator-execute',
    '--operator-api-key-secret', 'operator-api-key:key',
  ];
  await aorK8s([...installationOptions, 'adopt', '--confirm'], 'adopt compatible legacy Kubernetes resources');
  await aorK8s([...installationOptions, 'install', '--rollout-timeout', '210000'], 'install through aor Kubernetes manager');
  await aorK8s(['status'], 'verify aor Kubernetes status');
  await aorK8s(['doctor'], 'verify aor Kubernetes diagnostics');
  await aorK8s(['upgrade', '--rollout-timeout', '210000'], 'upgrade from recorded installation inventory');
  return { sourceNode, targetNode, apiKey, configPath };
}

async function verifyManagementSafety(configPath: string): Promise<void> {
  const installationOptions = [
    '--config-file', configPath,
    '--image', orchestratorImage,
    '--workspace-size', '20Gi',
    '--conversation-storage', '64Mi',
    '--operator-execute',
    '--operator-api-key-secret', 'operator-api-key:key',
  ];
  await aorK8s([...installationOptions, 'adopt', '--confirm'], 'restore ownership metadata changed by lifecycle fault injection');
  await kubectl([
    '-n', namespace, 'label', 'service', 'agent-orchestrator',
    'app.kubernetes.io/managed-by-', 'agentorchestrator.io/installation-id-',
  ], { label: 'make a managed Service foreign for conflict testing' });
  const conflict = await aorK8sMustFail(['upgrade'], 'reject a same-name foreign resource');
  if (!conflict.includes('Refusing to overwrite foreign resource')) {
    throw new Error(`foreign resource rejection returned an unexpected error: ${conflict}`);
  }
  await kubectl([
    '-n', namespace, 'label', 'service', 'agent-orchestrator', '--overwrite',
    'app.kubernetes.io/managed-by=aor', 'agentorchestrator.io/installation-id=k3d-e2e',
  ], { label: 'restore owned Service labels' });

  const workspaceUid = await kubectl([
    '-n', namespace, 'get', 'pvc', 'ao-workspace', '-o', 'jsonpath={.metadata.uid}',
  ], { capture: true, label: 'record workspace PVC UID' });
  await aorK8s(['uninstall', '--confirm'], 'normal uninstall preserves installation data');
  await kubectl([
    '-n', namespace, 'wait', '--for=delete', '--timeout=120s',
    'deployment/agent-orchestrator', 'deployment/placement-controller',
  ], { label: 'wait for normal uninstall workloads to terminate' });
  await kubectl(['-n', namespace, 'get', 'pvc', 'ao-workspace'], { label: 'verify workspace PVC preservation' });
  await kubectl(['-n', namespace, 'get', 'secret', 'agent-orchestrator-config'], { label: 'verify owned config preservation' });

  await aorK8s([
    ...installationOptions,
    'install', '--rollout-timeout', '210000',
  ], 'reinstall from preserved data');
  const resumedUid = await kubectl([
    '-n', namespace, 'get', 'pvc', 'ao-workspace', '-o', 'jsonpath={.metadata.uid}',
  ], { capture: true, label: 'verify workspace PVC identity after reinstall' });
  if (resumedUid !== workspaceUid) throw new Error('normal uninstall/reinstall replaced the workspace PVC');

  await aorK8s(['uninstall', '--confirm'], 'stop workloads before confirmed purge');
  await kubectl([
    '-n', namespace, 'wait', '--for=delete', '--timeout=120s',
    'deployment/agent-orchestrator', 'deployment/placement-controller',
  ], { label: 'wait for workloads before purge' });
  await aorK8s(['uninstall', '--purge-data', '--confirm'], 'purge owned Kubernetes installation data');
  const ownedData = await kubectl([
    '-n', namespace, 'get', 'pvc/ao-workspace', 'secret/agent-orchestrator-config', 'configmap/agent-orchestrator-installation',
    '--ignore-not-found=true', '-o', 'name',
  ], { capture: true, label: 'verify owned installation data was purged' });
  if (ownedData !== '') throw new Error(`owned data remained after purge: ${ownedData}`);
  await kubectl(['-n', namespace, 'get', 'secret', 'operator-api-key'], {
    label: 'verify external operator Secret preservation',
  });
}

async function main(): Promise<void> {
  const repeat = parseRepeat();
  let failed = false;
  try {
    const { sourceNode, targetNode, apiKey, configPath } = await prepareCluster();
    const testEnvironment: NodeJS.ProcessEnv = {
      ...clusterEnv(),
      K8S_E2E_CONTEXT: contextName,
      K8S_E2E_NAMESPACE: namespace,
      K8S_E2E_SOURCE_NODE: sourceNode,
      K8S_E2E_TARGET_NODE: targetNode,
      K8S_E2E_SHARED_ROOT: '/shared',
      K8S_E2E_RECONCILE_INTERVAL_MS: String(reconcileIntervalMs),
      K8S_E2E_API_KEY: apiKey,
      K8S_E2E_CLEANUP_OWNER: cleanupOwnerId,
      K8S_E2E_ORPHAN_GRACE_PERIOD_MS: String(orphanGracePeriodMs),
    };
    for (let runNumber = 1; runNumber <= repeat; runNumber += 1) {
      await run(process.execPath, [
        resolvePath(repoRoot, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config', resolvePath(repoRoot, 'e2e/vitest.config.kubernetes-migration.ts'),
      ], {
        env: testEnvironment,
        label: `cross-node migration suite (${runNumber}/${repeat})`,
        timeoutMs: 1_500_000,
      });
    }
    await verifyManagementSafety(configPath);
  } catch (err) {
    failed = true;
    process.stderr.write(`[k3d-e2e] ${(err as Error).stack ?? (err as Error).message}\n`);
    await diagnostics();
  } finally {
    try {
      await cleanup();
    } catch (err) {
      failed = true;
      process.stderr.write(`[k3d-e2e] cleanup failed: ${(err as Error).stack ?? (err as Error).message}\n`);
    }
  }
  if (failed) process.exitCode = 1;
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  process.once(signal, () => {
    for (const child of activeChildren) child.kill();
    void cleanup().then(
      () => process.exit(code),
      (err: unknown) => {
        process.stderr.write(`[k3d-e2e] cleanup failed after ${signal}: ${(err as Error).message}\n`);
        process.exit(1);
      },
    );
  });
}

void main();
