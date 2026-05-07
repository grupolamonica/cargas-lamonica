import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: [
      "benchmarks/db/pool-contention.bench.js",
      "benchmarks/app/queue-rebalance.bench.js",
      "benchmarks/app/route-cascade.bench.js",
    ],
    benchmark: {
      include: ["benchmarks/**/*.bench.js"],
      reporter: ["verbose"],
    },
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
