import { defineConfig } from "@playwright/test";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required production test environment: ${name}`);
  return value;
}

const proxyServer = process.env.TOKEN_TALK_PRODUCTION_PROXY?.trim();
const productionUrl = requiredEnvironment("TOKEN_TALK_PRODUCTION_URL");
if (new URL(productionUrl).protocol !== "https:") {
  throw new Error("Production browser QA requires an HTTPS URL");
}

export default defineConfig({
  testDir: "./apps/studio/e2e-production",
  outputDir: "./test-results/production",
  fullyParallel: false,
  workers: 1,
  timeout: 45 * 60_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  use: {
    baseURL: productionUrl,
    httpCredentials: {
      username: requiredEnvironment("TOKEN_TALK_PRODUCTION_USER"),
      password: requiredEnvironment("TOKEN_TALK_PRODUCTION_PASSWORD"),
    },
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "production-desktop",
      use: { viewport: { width: 1440, height: 960 } },
    },
    {
      name: "production-mobile",
      use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    },
  ],
});
