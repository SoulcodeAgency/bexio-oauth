import { defineConfig } from "@playwright/test";

const MOCK_PORT = 9401;
const APP_PORT = 3400;
const mock = `http://127.0.0.1:${MOCK_PORT}`;

// Everything the app needs, pointed at mock-bexio. Test-only values.
const env = {
  APP_URL: `http://localhost:${APP_PORT}`,
  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@127.0.0.1:5432/postgres",
  BETTER_AUTH_SECRET: "e2e-only-secret-e2e-only-secret-e2e-only",
  BEXIO_CLIENT_ID: "example-client",
  BEXIO_CLIENT_SECRET: "example-secret",
  BEXIO_ISSUER: `${mock}/realms/bexio`,
  BEXIO_API_BASE_URL: mock,
  BEXIO_SCOPES: "contact_show",
  BEXIO_TOKEN_KEYS: JSON.stringify({
    current: "e2e",
    keys: { e2e: "S1zKpyO8e3C3eY2WlD7ewGhv8OjPr_JqGv3tZ9cX1QA" },
  }),
  CRON_SECRET: "e2e-cron-secret",
  BEXIO_IDLE_FOR: "1s",
  AUTH_RATE_LIMIT: "off",
};

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: env.APP_URL, trace: "retain-on-failure" },
  webServer: [
    {
      command: "node ../_shared/mock-bexio/src/server.ts",
      url: `${mock}/__mock/stats`,
      env: { MOCK_BEXIO_PORT: String(MOCK_PORT) },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run migrate && npm run build && npm run start",
      url: `${env.APP_URL}/`,
      env,
      timeout: 240_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});

export const e2eEnv = { ...env, MOCK_URL: mock };
