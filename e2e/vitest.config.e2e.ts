import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['e2e/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
