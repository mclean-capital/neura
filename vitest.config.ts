import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['prototypes/*/src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    passWithNoTests: true,
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['prototypes/*/src/**/*.ts', 'packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
      exclude: ['**/*.test.ts', '**/*.spec.ts'],
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
