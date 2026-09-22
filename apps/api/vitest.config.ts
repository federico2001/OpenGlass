import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Same throwaway-Mongo (or MONGODB_URI) setup as @openglass/db.
    globalSetup: ["../../packages/db/test/globalSetup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
