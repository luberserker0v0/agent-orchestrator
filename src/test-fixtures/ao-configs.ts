import type { OrchestratorConfig } from '../config-loader.js';
import { loadDockerConfig } from './test-env.js';

const dockerCfg = loadDockerConfig();
export const TEST_DOCKER_IMAGE = dockerCfg.image;
export const TEST_CONTAINER_PORT = dockerCfg.containerPort;

export const defaultOrchestratorConfig: OrchestratorConfig = {
  maxInstances: 5,
  idleTimeoutMs: 600000,
  idleSweepIntervalMs: 60000,
  portRange: { start: 41000, end: 41050 },
  runtimeConfig: { binary: 'opencode' },
  agentType: 'opencode',
  healthCheck: { retries: 10, intervalMs: 500, clientTimeoutMs: 5000 },
  runtime: 'direct',
};

export const dockerOrchestratorConfig: OrchestratorConfig = {
  ...defaultOrchestratorConfig,
  runtime: 'docker',
  runtimeConfig: { binary: 'opencode', docker: { image: TEST_DOCKER_IMAGE, containerPort: TEST_CONTAINER_PORT } },
};
