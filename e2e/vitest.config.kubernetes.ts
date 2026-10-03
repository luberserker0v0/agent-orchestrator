import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['e2e/scenarios/kubernetes/**/*.test.ts'],
    exclude: ['e2e/scenarios/kubernetes/cross-node-migration.test.ts'],
    testTimeout: 360_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
