import { defineConfig } from "@playwright/test";

const e2eWorkspace = `workspace/e2e-${process.pid}`;

export default defineConfig({
  testDir: "./apps/studio/e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4310",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `TOKEN_TALK_WORKSPACE=${e2eWorkspace} pnpm dev`,
    url: "http://127.0.0.1:4310/api/bootstrap",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop",
      use: { viewport: { width: 1440, height: 960 } },
    },
    {
      name: "mobile",
      use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    },
  ],
});
