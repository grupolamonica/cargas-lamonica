import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.{test,spec}.{js,mjs,ts}"],
    exclude: ["benchmarks/**", "node_modules/**"],
  },
  resolve: {
    alias: {},
  },
});
