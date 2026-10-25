import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "infra/test/**/*.test.ts", "tests/**/*.test.ts"],
    // La synthèse CDK prend quelques secondes.
    testTimeout: 60_000,
  },
});
