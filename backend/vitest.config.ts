import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["server/**/*.{test,spec}.{js,mjs,ts}"],
  },
  resolve: {
    alias: {},
  },
});
