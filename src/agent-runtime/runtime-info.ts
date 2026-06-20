import type { AgentOrchestratorConfig, RuntimeEntry } from '../config-loader.js';
import { RuntimeRegistry } from './registry.js';
import { RuntimeManager } from './runtime-manager.js';
import { getRuntimeVersion } from './versions.js';

export interface RuntimeInfoEntry {
  id: string;
  type: string;
  version?: string;
  config: Record<string, unknown>;
  registered: boolean;
  instanceCount: number;
  capabilities?: string[];
}

export class RuntimeInfoProvider {
  constructor(
    private config: AgentOrchestratorConfig,
    private registry: RuntimeRegistry,
    private manager: RuntimeManager,
  ) {}

  getRuntimeInfoList(): RuntimeInfoEntry[] {
    return this.config.orchestrator.runtimes.map(entry => this.buildInfo(entry));
  }

  getRuntimeInfo(id: string): RuntimeInfoEntry | undefined {
    const entry = this.config.orchestrator.runtimes.find(r => r.id === id);
    if (!entry) return undefined;
    return this.buildInfo(entry);
  }

  private buildInfo(entry: RuntimeEntry): RuntimeInfoEntry {
    const rt = this.registry.get(entry.id);

    return {
      id: entry.id,
      type: entry.type,
      version: getRuntimeVersion(this.config, entry.id),
      config: entry.config as unknown as Record<string, unknown>,
      registered: this.registry.has(entry.id),
      instanceCount: this.manager.listInstances().length,
      capabilities: rt?.capabilities ? (Object.keys(rt.capabilities) as (keyof typeof rt.capabilities)[]).filter(k => rt.capabilities[k]) : undefined,
    };
  }
}
