import { execFileSync, spawn } from 'node:child_process';

export const K8S_CONTEXT = process.env.K8S_E2E_CONTEXT ?? 'k3d-ao-test';
export const K8S_NAMESPACE = process.env.K8S_E2E_NAMESPACE ?? 'ao-instances';

export function kubectl(args: string[], timeout = 30_000): string {
  return execFileSync('kubectl', ['--context', K8S_CONTEXT, ...args], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function kubectlJson<T>(args: string[], timeout = 30_000): T {
  return JSON.parse(kubectl([...args, '-o', 'json'], timeout)) as T;
}

export function kubectlApply(body: object, timeout = 30_000): void {
  execFileSync('kubectl', ['--context', K8S_CONTEXT, 'apply', '-f', '-'], {
    encoding: 'utf8',
    input: JSON.stringify(body),
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function resourceExists(kind: string, name: string): boolean {
  return kubectl([
    '-n', K8S_NAMESPACE,
    'get', kind, name,
    '--ignore-not-found=true',
    '-o', 'name',
  ], 10_000) !== '';
}

export function deleteResource(kind: string, name: string): void {
  try {
    kubectl(['-n', K8S_NAMESPACE, 'delete', kind, name, '--ignore-not-found=true', '--wait=false'], 15_000);
  } catch {
    // Best-effort cleanup; the caller can still report the original failure.
  }
}

export async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 60_000,
  intervalMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${description}${suffix}`);
}

export function readLiveApiKey(): string {
  const secret = kubectlJson<{ data?: Record<string, string> }>([
    '-n', K8S_NAMESPACE, 'get', 'secret', 'agent-orchestrator-config',
  ]);
  const encoded = secret.data?.['agentorchestrator.json'];
  if (!encoded) throw new Error('agent-orchestrator-config is missing agentorchestrator.json');
  const config = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
    server?: { apiKeys?: Array<{ key?: string }> };
  };
  const key = config.server?.apiKeys?.[0]?.key;
  if (!key) throw new Error('Live orchestrator config has no API key');
  return key;
}

export interface PortForward {
  baseUrl: string;
  close(): Promise<void>;
}

export async function startOrchestratorPortForward(): Promise<PortForward> {
  const child = spawn(
    'kubectl',
    [
      '--context', K8S_CONTEXT,
      '-n', K8S_NAMESPACE,
      'port-forward', 'service/agent-orchestrator', ':8080',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const port = await new Promise<number>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`kubectl port-forward did not become ready: ${output}`));
    }, 15_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = output.match(/Forwarding from (?:127\.0\.0\.1|\[::1\]):(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`kubectl port-forward exited before readiness (code ${code}): ${output}`));
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 5_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill();
      });
    },
  };
}

export function assertKubernetesPrerequisites(): void {
  const currentContext = execFileSync('kubectl', ['config', 'current-context'], {
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  if (currentContext !== K8S_CONTEXT) {
    throw new Error(
      `Kubernetes runtime uses the current kubeconfig context (${currentContext}); switch it to ${K8S_CONTEXT} before running this suite`,
    );
  }
  kubectl(['get', 'nodes'], 10_000);
  const instancePhases = JSON.parse(kubectl([
    'get', 'crd', 'opencodeinstances.agentorchestrator.io',
    '-o', "jsonpath={.spec.versions[?(@.name=='v1alpha1')].schema.openAPIV3Schema.properties.status.properties.phase.enum}",
  ], 10_000)) as string[];
  if (!instancePhases.includes('Stopped')) {
    throw new Error('Installed OpencodeInstance CRD is stale: status.phase must include Stopped');
  }
  kubectl(['-n', K8S_NAMESPACE, 'get', 'deployment', 'agent-orchestrator'], 10_000);
  kubectl(['-n', K8S_NAMESPACE, 'get', 'deployment', 'placement-controller'], 10_000);
  const permissions = [
    ['delete', 'persistentvolumeclaims', `system:serviceaccount:${K8S_NAMESPACE}:agent-orchestrator`],
    ['update', 'opencodeinstances/status', `system:serviceaccount:${K8S_NAMESPACE}:agent-orchestrator`],
    ['update', 'conversationroutes/status', `system:serviceaccount:${K8S_NAMESPACE}:placement-controller`],
    ['delete', 'persistentvolumeclaims', `system:serviceaccount:${K8S_NAMESPACE}:placement-controller`],
  ];
  for (const [verb, resource, serviceAccount] of permissions) {
    const allowed = kubectl([
      'auth', 'can-i', verb, resource,
      `--as=${serviceAccount}`,
      '-n', K8S_NAMESPACE,
    ], 10_000);
    if (allowed !== 'yes') {
      throw new Error(`${serviceAccount} cannot ${verb} ${resource} in ${K8S_NAMESPACE}`);
    }
  }
}
