import { describe, it, expect } from 'vitest';
import { PortPool } from '../orchestrator/port-pool.js';
import { RuntimeFactory } from './runtime-factory.js';
import type { AgentRuntime, AgentCapabilities, SpawnResult } from './types.js';

class FakeRuntime implements AgentRuntime {
  readonly type = 'fake';
  readonly capabilities: AgentCapabilities = {
    sessions: false, streaming: false, files: false,
    tools: false, config: false, agents: false, skills: false,
  };
  async spawn(): Promise<SpawnResult> { return { client: {} as any, port: 0 }; }
  async kill(): Promise<void> {}
  async restart(): Promise<SpawnResult> { return { client: {} as any, port: 0 }; }
}

describe('RuntimeFactory', () => {
  it('creates a registered runtime', () => {
    const factory = new RuntimeFactory();
    factory.register('fake', FakeRuntime);

    const runtime = factory.create('fake', {} as PortPool, {});
    expect(runtime).toBeInstanceOf(FakeRuntime);
    expect(runtime.type).toBe('fake');
  });

  it('throws for unregistered type', () => {
    const factory = new RuntimeFactory();
    expect(() => factory.create('unknown', {} as PortPool, {})).toThrow('Unknown runtime type: unknown');
  });

  it('overwrites registration for same type', () => {
    class RT1 implements AgentRuntime {
      readonly type = 'rt1';
      readonly capabilities: AgentCapabilities = {
        sessions: false, streaming: false, files: false,
        tools: false, config: false, agents: false, skills: false,
      };
      async spawn(): Promise<SpawnResult> { return { client: {} as any, port: 0 }; }
      async kill(): Promise<void> {}
      async restart(): Promise<SpawnResult> { return { client: {} as any, port: 0 }; }
    }
    class RT2 implements AgentRuntime {
      readonly type = 'rt2';
      readonly capabilities: AgentCapabilities = {
        sessions: false, streaming: false, files: false,
        tools: false, config: false, agents: false, skills: false,
      };
      async spawn(): Promise<SpawnResult> { return { client: {} as any, port: 0 }; }
      async kill(): Promise<void> {}
      async restart(): Promise<SpawnResult> { return { client: {} as any, port: 0 }; }
    }

    const factory = new RuntimeFactory();
    factory.register('rt', RT1);
    factory.register('rt', RT2);

    const runtime = factory.create('rt', {} as PortPool, {});
    expect(runtime).toBeInstanceOf(RT2);
  });
});
