import { describe, it, expect } from 'vitest';
import { RuntimeRegistry } from './registry.js';

describe('RuntimeRegistry', () => {
  const mockRuntime = {
    type: 'test-runtime',
    capabilities: { sessions: false, streaming: false, files: false, tools: false, config: false, agents: false, skills: false },
    spawn: async () => ({ client: {} as any }),
    kill: async () => {},
  };

  it('registers and retrieves a runtime by type', () => {
    const registry = new RuntimeRegistry();
    registry.register(mockRuntime);
    expect(registry.get('test-runtime')).toBe(mockRuntime);
  });

  it('getOrThrow returns the runtime when registered', () => {
    const registry = new RuntimeRegistry();
    registry.register(mockRuntime);
    expect(registry.getOrThrow('test-runtime')).toBe(mockRuntime);
  });

  it('getOrThrow throws for unknown type with available list', () => {
    const registry = new RuntimeRegistry();
    registry.register(mockRuntime);
    expect(() => registry.getOrThrow('unknown')).toThrow(
      'Unknown agent runtime: unknown. Available: test-runtime',
    );
  });

  it('register throws on duplicate type', () => {
    const registry = new RuntimeRegistry();
    registry.register(mockRuntime);
    expect(() => registry.register(mockRuntime)).toThrow(
      'Runtime already registered: test-runtime',
    );
  });

  it('list returns registered type names', () => {
    const registry = new RuntimeRegistry();
    registry.register(mockRuntime);
    expect(registry.list()).toEqual(['test-runtime']);
  });

  it('getAll returns all registered runtimes', () => {
    const registry = new RuntimeRegistry();
    registry.register(mockRuntime);
    const all = registry.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toBe(mockRuntime);
  });

  it('get returns undefined for unregistered type', () => {
    const registry = new RuntimeRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('empty registry returns empty list and array', () => {
    const registry = new RuntimeRegistry();
    expect(registry.list()).toEqual([]);
    expect(registry.getAll()).toEqual([]);
  });

  it('supports multiple runtimes simultaneously', () => {
    const rt1 = { ...mockRuntime, type: 'rt1' };
    const rt2 = { ...mockRuntime, type: 'rt2' };
    const registry = new RuntimeRegistry();
    registry.register(rt1);
    registry.register(rt2);
    expect(registry.list()).toEqual(['rt1', 'rt2']);
    expect(registry.getAll()).toHaveLength(2);
    expect(registry.get('rt1')).toBe(rt1);
    expect(registry.get('rt2')).toBe(rt2);
  });
});
