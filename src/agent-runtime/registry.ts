import type { AgentRuntime } from './types.js';

interface RegisteredRuntime {
  runtime?: AgentRuntime;
  isValid: boolean;
  error?: string;
}

export class RuntimeRegistry {
  private runtimes = new Map<string, RegisteredRuntime>();

  register(id: string, runtime: AgentRuntime): void {
    if (this.runtimes.has(id)) {
      throw new Error(`Runtime already registered: ${id}`);
    }
    this.runtimes.set(id, { runtime, isValid: true });
  }

  registerInvalid(id: string, error: string): void {
    if (this.runtimes.has(id)) {
      throw new Error(`Runtime already registered: ${id}`);
    }
    this.runtimes.set(id, { isValid: false, error });
  }

  has(id: string): boolean {
    return this.runtimes.has(id);
  }

  isValid(id: string): boolean {
    return this.runtimes.get(id)?.isValid ?? false;
  }

  getValidity(id: string): { isValid: boolean; error?: string } | undefined {
    const entry = this.runtimes.get(id);
    if (!entry) return undefined;
    return { isValid: entry.isValid, error: entry.error };
  }

  get(type: string): AgentRuntime | undefined {
    const entry = this.runtimes.get(type);
    if (!entry || !entry.isValid || !entry.runtime) return undefined;
    return entry.runtime;
  }

  getOrThrow(type: string): AgentRuntime {
    const entry = this.runtimes.get(type);
    if (!entry) {
      throw new Error(`Unknown agent runtime: ${type}. Available: ${this.list().join(', ')}`);
    }
    if (!entry.isValid || !entry.runtime) {
      throw new Error(`Runtime "${type}" is not available: ${entry.error ?? 'unknown error'}`);
    }
    return entry.runtime;
  }

  list(): string[] {
    return Array.from(this.runtimes.keys());
  }

  getAll(): AgentRuntime[] {
    return Array.from(this.runtimes.values())
      .filter(e => e.isValid && e.runtime)
      .map(e => e.runtime!);
  }
}
