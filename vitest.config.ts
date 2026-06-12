import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: (() => {
      if (process.env.E2E_RUNTIME === 'docker' || process.env.E2E_RUNTIME === 'e2e') {
        return ['e2e/scenarios/lifecycle/*.test.ts']
      }
    
      return ['src/**/*.test.ts']
    })(),
    coverage: {
      provider: 'v8',
      enabled: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/**/types.ts',
        'src/**/*.d.ts',
      ],
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        lines: 70,
        functions: 75,
        branches: 55,
        statements: 65,
      },
    },
  },
});
