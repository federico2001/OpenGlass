import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Same throwaway Mongo + MinIO setup as @openglass/db; the end-to-end test runs the real
    // OpenGlass API in-process against them.
    globalSetup: ["../../packages/db/test/globalSetup.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
