import type { AgentRuntime } from './types.js';
import { PortPool } from '../orchestrator/port-pool.js';

type RuntimeConstructor = new (portPool: PortPool, config: any) => AgentRuntime;

export class RuntimeFactory {
  private constructors = new Map<string, RuntimeConstructor>();

  register(type: string, ctor: RuntimeConstructor): void {
    this.constructors.set(type, ctor);
  }

  create(type: string, portPool: PortPool, config: unknown): AgentRuntime {
    const ctor = this.constructors.get(type);
    if (!ctor) {
      throw new Error(`Unknown runtime type: ${type}. Did you forget to register it?`);
    }
    return new ctor(portPool, config);
  }
}
