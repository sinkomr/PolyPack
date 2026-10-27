import { defineConfig } from "vitest/config";

// `npm test` skips the search-quality benchmarks (*.quality.test.ts, minutes of real optimization);
// `npm run test:quality` runs only those, with vitest.quality.config.ts.
export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.quality.test.ts"],
    testTimeout: 180000,
  },
});
