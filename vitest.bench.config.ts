import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * The benchmark suite — run by `pnpm bench`, and in CI as its own job.
 *
 * It is a separate config rather than a tag on the main run because a timing test has requirements the
 * rest of the suite does not:
 *
 *   - **A machine to itself.** `fileParallelism: false` and a single fork. Vitest's default is to fan
 *     suites out across workers, and a benchmark sharing cores with a fuzz test measures the scheduler.
 *     When these ran together, the batch test misreported a 2× regression as 4.6× and starved the
 *     convergence property test into a timeout — the timing suite turned a green build red by standing
 *     next to it.
 *   - **Room to run.** The 500-block fixtures are built repeatedly; 60s beats the 5s default rather
 *     than encouraging someone to shrink the fixture until it fits, which would quietly stop testing
 *     the thing that matters (scale).
 *
 * These are thresholds, not micro-benchmarks. They exist to catch an *algorithmic* regression — a
 * keystroke that starts scanning the whole document — which shows up as 10×, not 1.1×. They are
 * deliberately not tuned so tight that a noisy CI runner fails them, because a benchmark that cries
 * wolf gets deleted.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.bench.test.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
