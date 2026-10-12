import { defineConfig, devices } from "@playwright/test";
const production = process.env.POLYPACK_E2E_PRODUCTION === "1";

// The end-to-end tests run against their own server (in-memory database) and web dev server,
// on ports that do not clash with `npm run dev`.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5174" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: /mobile/ },
    { name: "phone", use: { ...devices["Pixel 7"] }, testMatch: /mobile/ },
  ],
  webServer: [
    {
      command: "npx tsx apps/server/src/node.ts",
      env: { PORT: "8788", DATABASE_PATH: ":memory:", ADMIN_TOKEN: "e2e-token" },
      url: "http://localhost:8788/api/health",
      reuseExistingServer: false,
    },
    {
      command: production ? "npx vite preview apps/web --port 5174 --strictPort" : "npx vite apps/web --port 5174 --strictPort",
      env: { POLYPACK_API: "http://localhost:8788" },
      url: "http://localhost:5174",
      reuseExistingServer: false,
    },
  ],
});
