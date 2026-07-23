import { defineConfig } from 'vitest/config';

const runtime = process.env.E2E_RUNTIME || 'docker';
const isDocker = runtime === 'docker';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['e2e/scenarios/runtime/**/*.test.ts'],
    testTimeout: isDocker ? 120_000 : 60_000,
    hookTimeout: isDocker ? 60_000 : 30_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    env: { E2E_RUNTIME: runtime },
  },
});
