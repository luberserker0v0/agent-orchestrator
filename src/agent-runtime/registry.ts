import type { AgentRuntime } from './types.js';

export class RuntimeRegistry {
  private runtimes = new Map<string, AgentRuntime>();

  register(runtime: AgentRuntime): void {
    if (this.runtimes.has(runtime.type)) {
      throw new Error(`Runtime already registered: ${runtime.type}`);
    }
    this.runtimes.set(runtime.type, runtime);
  }

  get(type: string): AgentRuntime | undefined {
    return this.runtimes.get(type);
  }

  getOrThrow(type: string): AgentRuntime {
    const runtime = this.runtimes.get(type);
    if (!runtime) {
      throw new Error(`Unknown agent runtime: ${type}. Available: ${this.list().join(', ')}`);
    }
    return runtime;
  }

  list(): string[] {
    return Array.from(this.runtimes.keys());
  }

  getAll(): AgentRuntime[] {
    return Array.from(this.runtimes.values());
  }
}
