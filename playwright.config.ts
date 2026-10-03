import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://plenty:plenty@localhost:5432/plenty_e2e";

/**
 * End-to-end tests run against a production build on a dedicated database
 * (reset + migrated by e2e/global-setup.ts). Receipts are read with the
 * on-device OCR provider so no external services are needed.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    timeout: 400_000,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_URL,
      APP_URL: `http://localhost:${PORT}`,
      AI_PROVIDER: "local",
      // The test walks the whole loop (predictions, weekly plans, per-person ownership), which is what the paid plans include.
      PLAN_OVERRIDE: "family",
      DEMO_MODE: "true",
      CRON_SECRET: "e2e-secret",
      STORAGE_DIR: ".data/e2e-uploads",
      NODE_ENV: "production",
      SMTP_URL: "",
      EMAIL_OUTBOX: "true",
    },
  },
});
