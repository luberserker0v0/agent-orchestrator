import type { OrchestratorConfig } from '../config-loader.js';
import { loadDockerConfig } from './test-env.js';

export const TEST_PORT_RANGE = { start: 30000, end: 30050 };

const dockerCfg = loadDockerConfig();
export const TEST_DOCKER_IMAGE = dockerCfg.image;
export const TEST_CONTAINER_PORT = dockerCfg.containerPort;

export const defaultOrchestratorConfig: OrchestratorConfig = {
  maxInstances: 5,
  idleTimeoutMs: 600000,
  idleSweepIntervalMs: 60000,
  portRange: { start: 30000, end: 30050 },
  opencodeBinary: 'opencode',
  healthCheck: { retries: 10, intervalMs: 500 },
  runtime: 'direct',
};

export const dockerOrchestratorConfig: OrchestratorConfig = {
  ...defaultOrchestratorConfig,
  runtime: 'docker',
  docker: { image: TEST_DOCKER_IMAGE, containerPort: TEST_CONTAINER_PORT },
};
