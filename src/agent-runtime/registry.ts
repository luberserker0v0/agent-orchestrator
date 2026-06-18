import type { AgentRuntime } from './types.js';

export class RuntimeRegistry {
  private runtimes = new Map<string, AgentRuntime>();

  register(id: string, runtime: AgentRuntime): void {
    if (this.runtimes.has(id)) {
      throw new Error(`Runtime already registered: ${id}`);
    }
    this.runtimes.set(id, runtime);
  }

  has(id: string): boolean {
    return this.runtimes.has(id);
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
