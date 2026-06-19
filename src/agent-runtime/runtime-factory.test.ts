import { describe, it, expect } from 'vitest';
import { PortPool } from '../orchestrator/port-pool.js';
import { RuntimeFactory } from './runtime-factory.js';
import type { AgentRuntime, AgentCapabilities, AgentEndpoint } from './types.js';

class FakeRuntime implements AgentRuntime {
  readonly type = 'fake';
  readonly capabilities: AgentCapabilities = {
    sessions: false, streaming: false, files: false,
    tools: false, config: false, agents: false, skills: false,
  };
  async start(): Promise<AgentEndpoint> { return { client: {} as any, port: 0 }; }
  async stop(): Promise<void> {}
  async restart(): Promise<AgentEndpoint> { return { client: {} as any, port: 0 }; }
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
      async start(): Promise<AgentEndpoint> { return { client: {} as any, port: 0 }; }
      async stop(): Promise<void> {}
      async restart(): Promise<AgentEndpoint> { return { client: {} as any, port: 0 }; }
    }
    class RT2 implements AgentRuntime {
      readonly type = 'rt2';
      readonly capabilities: AgentCapabilities = {
        sessions: false, streaming: false, files: false,
        tools: false, config: false, agents: false, skills: false,
      };
      async start(): Promise<AgentEndpoint> { return { client: {} as any, port: 0 }; }
      async stop(): Promise<void> {}
      async restart(): Promise<AgentEndpoint> { return { client: {} as any, port: 0 }; }
    }

    const factory = new RuntimeFactory();
    factory.register('rt', RT1);
    factory.register('rt', RT2);

    const runtime = factory.create('rt', {} as PortPool, {});
    expect(runtime).toBeInstanceOf(RT2);
  });

  it('hasType returns true for registered types', () => {
    const factory = new RuntimeFactory();
    factory.register('fake', FakeRuntime);
    expect(factory.hasType('fake')).toBe(true);
    expect(factory.hasType('nope')).toBe(false);
  });

  it('validateConfig returns empty array when no validator registered', () => {
    const factory = new RuntimeFactory();
    factory.register('fake', FakeRuntime);
    expect(factory.validateConfig('fake', { whatever: 1 })).toEqual([]);
  });

  it('validateConfig returns errors from registered validator', () => {
    const factory = new RuntimeFactory();
    factory.register('docker', FakeRuntime, (config) => {
      const errs: string[] = [];
      const cfg = config as Record<string, unknown>;
      if (!cfg?.image || typeof cfg.image !== 'string') errs.push('"image" is required');
      if (!Number.isInteger(cfg?.containerPort)) errs.push('"containerPort" must be a positive integer');
      return errs;
    });

    expect(factory.validateConfig('docker', {})).toEqual(['"image" is required', '"containerPort" must be a positive integer']);
    expect(factory.validateConfig('docker', { image: 'img' })).toEqual(['"containerPort" must be a positive integer']);
    expect(factory.validateConfig('docker', { image: 'img', containerPort: 3000 })).toEqual([]);
  });

  it('validateConfig returns empty for unregistered type', () => {
    const factory = new RuntimeFactory();
    expect(factory.validateConfig('unknown', {})).toEqual([]);
  });
});
