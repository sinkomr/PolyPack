import { defineConfig } from "vitest/config";

// Search-quality benchmarks only: seed-success rates, races between methods, known packings.
export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.quality.test.ts", "apps/**/test/**/*.quality.test.ts"],
    exclude: ["**/node_modules/**"],
    testTimeout: 900000,
  },
});
