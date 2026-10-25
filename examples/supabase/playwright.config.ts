import { defineConfig } from "@playwright/test";

const MOCK_PORT = 9402;
const APP_PORT = 3300;
const mock = `http://127.0.0.1:${MOCK_PORT}`;

// Defaults match `supabase start` with this example's config.toml. The anon
// key is the public demo key every local Supabase stack uses.
const env = {
  APP_URL: `http://localhost:${APP_PORT}`,
  NEXT_PUBLIC_SUPABASE_URL:
    process.env.SUPABASE_URL ?? "http://127.0.0.1:55621",
  NEXT_PUBLIC_SUPABASE_ANON_KEY:
    process.env.SUPABASE_ANON_KEY ??
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
  DATABASE_URL:
    process.env.SUPABASE_DB_URL ??
    "postgresql://postgres:postgres@127.0.0.1:55622/postgres",
  BEXIO_CLIENT_ID: "example-client",
  BEXIO_CLIENT_SECRET: "example-secret",
  BEXIO_ISSUER: `${mock}/realms/bexio`,
  BEXIO_API_BASE_URL: mock,
  BEXIO_SCOPES: "contact_show",
  BEXIO_TOKEN_KEYS: JSON.stringify({
    current: "e2e",
    keys: { e2e: "S1zKpyO8e3C3eY2WlD7ewGhv8OjPr_JqGv3tZ9cX1QA" },
  }),
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
      command: "npm run build && npm run start",
      url: `${env.APP_URL}/`,
      env,
      timeout: 240_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});

export const e2eEnv = { ...env, MOCK_URL: mock };
