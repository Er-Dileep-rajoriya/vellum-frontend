import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    /**
     * The benchmark is excluded from the default run and has its own config (`vitest.bench.config.ts`,
     * run by `pnpm bench`).
     *
     * Not for speed — for validity. Vitest runs suites in parallel across workers, so a benchmark
     * sharing the machine with the fuzz test is measuring the OS scheduler as much as the code. It cut
     * both ways: the benchmark reported a batch as 4.6× slower than it is, and it starved the
     * convergence property test badly enough to trip its timeout — a red build caused entirely by the
     * timing suite standing next to it. A measurement that perturbs what it measures is not a
     * measurement.
     */
    exclude: ["node_modules/**", "e2e/**", "src/**/*.bench.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["src/crdt/**", "src/sync-engine/**", "src/services/**"],
    },
  },
});
