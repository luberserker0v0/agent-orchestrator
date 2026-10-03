import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['e2e/scenarios/kubernetes/cross-node-migration.test.ts'],
    testTimeout: 660_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
