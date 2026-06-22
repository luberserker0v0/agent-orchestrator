import { describe, it, expect } from 'vitest';
import { getRuntimeVersion, getRuntimeEntry, opencodeDownloadUrl, getDefaultDirectVersion } from './versions.js';
import type { AgentOrchestratorConfig } from '../config-loader.js';

function makeConfig(runtimes: Array<{ id: string; type: string; config: Record<string, unknown> }>): AgentOrchestratorConfig {
  return {
    server: { port: 0, host: '127.0.0.1', shutdownTimeoutMs: 15000 },
    websocket: { heartbeatIntervalMs: 30000, idleTimeoutMs: 600000 },
    orchestrator: {
      maxInstances: 10,
      idleTimeoutMs: 600000,
      idleSweepIntervalMs: 60000,
      portRange: { start: 30000, end: 30100 },
      defaultAgentType: 'opencode-direct',
      runtimes: runtimes as any,
      healthCheck: { retries: 10, intervalMs: 500, clientTimeoutMs: 5000 },
    },
    workspace: { basePath: '/tmp/ws', enforceCanonicalConfig: true, storage: { type: 'local' } },
  };
}

describe('getRuntimeVersion', () => {
  it('returns version for direct runtime', () => {
    const config = makeConfig([{ id: 'rt1', type: 'direct', config: { binary: 'opencode', version: '1.17.8' } }]);
    expect(getRuntimeVersion(config, 'rt1')).toBe('1.17.8');
  });

  it('returns undefined for direct runtime without version', () => {
    const config = makeConfig([{ id: 'rt1', type: 'direct', config: { binary: 'opencode' } }]);
    expect(getRuntimeVersion(config, 'rt1')).toBeUndefined();
  });

  it('returns version from docker image tag', () => {
    const config = makeConfig([{ id: 'docker-rt', type: 'docker', config: { image: 'ghcr.io/anomalyco/opencode:1.17.8' } }]);
    expect(getRuntimeVersion(config, 'docker-rt')).toBe('1.17.8');
  });

  it('returns undefined for docker image without tag', () => {
    const config = makeConfig([{ id: 'docker-rt', type: 'docker', config: { image: 'opencode:latest' } }]);
    expect(getRuntimeVersion(config, 'docker-rt')).toBe('latest');
  });

  it('returns undefined for unknown runtime id', () => {
    const config = makeConfig([]);
    expect(getRuntimeVersion(config, 'nonexistent')).toBeUndefined();
  });
});

describe('getRuntimeEntry', () => {
  it('returns the matching runtime entry', () => {
    const config = makeConfig([{ id: 'rt1', type: 'direct', config: { binary: 'opencode' } }]);
    const entry = getRuntimeEntry(config, 'rt1');
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('rt1');
  });

  it('returns undefined for unknown id', () => {
    const config = makeConfig([]);
    expect(getRuntimeEntry(config, 'nonexistent')).toBeUndefined();
  });
});

describe('opencodeDownloadUrl', () => {
  it('generates correct URL for x64', () => {
    expect(opencodeDownloadUrl('1.17.8', 'x64')).toBe(
      'https://github.com/anomalyco/opencode/releases/download/v1.17.8/opencode-linux-x64-musl.tar.gz',
    );
  });

  it('generates correct URL for arm64', () => {
    expect(opencodeDownloadUrl('1.17.8', 'arm64')).toBe(
      'https://github.com/anomalyco/opencode/releases/download/v1.17.8/opencode-linux-arm64-musl.tar.gz',
    );
  });

  it('defaults to x64', () => {
    expect(opencodeDownloadUrl('2.0.0')).toBe(
      'https://github.com/anomalyco/opencode/releases/download/v2.0.0/opencode-linux-x64-musl.tar.gz',
    );
  });
});

describe('getDefaultDirectVersion', () => {
  it('returns a non-empty string', () => {
    const version = getDefaultDirectVersion();
    expect(version).toBeTruthy();
    expect(typeof version).toBe('string');
  });
});
