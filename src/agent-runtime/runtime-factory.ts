import type { AgentRuntime } from './types.js';
import { PortPool } from '../orchestrator/port-pool.js';

type RuntimeConstructor = new (portPool: PortPool, config: any) => AgentRuntime;

export class RuntimeFactory {
  private constructors = new Map<string, RuntimeConstructor>();
  private validators = new Map<string, (config: unknown) => string[]>();

  register(type: string, ctor: RuntimeConstructor, configValidator?: (config: unknown) => string[]): void {
    this.constructors.set(type, ctor);
    if (configValidator) {
      this.validators.set(type, configValidator);
    }
  }

  hasType(type: string): boolean {
    return this.constructors.has(type);
  }

  validateConfig(type: string, config: unknown): string[] {
    const validator = this.validators.get(type);
    if (!validator) return [];
    return validator(config);
  }

  create(type: string, portPool: PortPool, config: unknown): AgentRuntime {
    const ctor = this.constructors.get(type);
    if (!ctor) {
      throw new Error(`Unknown runtime type: ${type}. Did you forget to register it?`);
    }
    return new ctor(portPool, config);
  }
}
