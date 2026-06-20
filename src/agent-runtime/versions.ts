import type { AgentOrchestratorConfig, RuntimeEntry } from '../config-loader.js';

export function getRuntimeVersion(config: AgentOrchestratorConfig, runtimeId: string): string | undefined {
  const entry = config.orchestrator.runtimes.find(r => r.id === runtimeId);
  if (!entry) return undefined;
  if (entry.type === 'direct') return entry.config.version;
  if (entry.type === 'docker') return entry.config.image.split(':')[1] ?? undefined;
  return undefined;
}

export function getRuntimeEntry(config: AgentOrchestratorConfig, runtimeId: string): RuntimeEntry | undefined {
  return config.orchestrator.runtimes.find(r => r.id === runtimeId);
}

export function opencodeDownloadUrl(version: string, arch: 'x64' | 'arm64' = 'x64'): string {
  return `https://github.com/anomalyco/opencode/releases/download/v${version}/opencode-linux-${arch}-musl.tar.gz`;
}

export function getDefaultDirectVersion(): string {
  return '1.17.8';
}
