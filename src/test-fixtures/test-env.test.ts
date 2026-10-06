import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DOCKER_TEST_IMAGE, loadDockerConfig } from './test-env.js';

describe('loadDockerConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses the pinned OpenCode image by default', () => {
    vi.stubEnv('AO_TEST_DOCKER_IMAGE', '');

    expect(loadDockerConfig()).toEqual({ image: DEFAULT_DOCKER_TEST_IMAGE });
  });

  it('honors an explicit Docker image override', () => {
    vi.stubEnv('AO_TEST_DOCKER_IMAGE', 'registry.example/opencode:test');

    expect(loadDockerConfig()).toEqual({ image: 'registry.example/opencode:test' });
  });
});
