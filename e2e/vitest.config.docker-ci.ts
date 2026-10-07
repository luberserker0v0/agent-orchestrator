import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['e2e/scenarios/runtime/docker-runtime.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    env: {
      E2E_RUNTIME: 'docker',
      AO_TEST_MODEL_AVAILABLE: 'false',
    },
  },
});
