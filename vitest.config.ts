import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 10_000,
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/test-setup.ts", "src/index.ts"],
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
    setupFiles: ["src/test-setup.ts"],
  },
});
