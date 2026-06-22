import type { OrchestratorConfig } from '../config-loader.js';
import { loadDockerConfig } from './test-env.js';

const dockerCfg = loadDockerConfig();
export const TEST_DOCKER_IMAGE = dockerCfg.image;

export const defaultOrchestratorConfig: OrchestratorConfig = {
  maxInstances: 5,
  idleTimeoutMs: 600000,
  idleSweepIntervalMs: 60000,
  portRange: { start: 41000, end: 41050 },
  defaultAgentType: 'opencode-direct',
  runtimes: [{ id: 'opencode-direct', type: 'direct', config: { binary: 'opencode' } }],
  healthCheck: { retries: 10, intervalMs: 500, clientTimeoutMs: 5000 },
};

export const dockerOrchestratorConfig: OrchestratorConfig = {
  ...defaultOrchestratorConfig,
  defaultAgentType: 'opencode-docker',
  runtimes: [{ id: 'opencode-docker', type: 'docker', config: { image: TEST_DOCKER_IMAGE } }],
};
