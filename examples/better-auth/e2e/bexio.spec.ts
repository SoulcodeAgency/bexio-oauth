import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { e2eEnv } from "../playwright.config";

const ADA = "8f1c2a8e-0001-4000-8000-000000000001";
const GRACE = "8f1c2a8e-0002-4000-8000-000000000002";
const cron = { Authorization: `Bearer ${e2eEnv.CRON_SECRET}` };

const db = new pg.Pool({ connectionString: e2eEnv.DATABASE_URL });

/** Who "logs in" at the mock on the next authorization request. */
async function nextLogin(login: {
  sub?: string;
  companyId?: string;
  error?: string;
}) {
  await fetch(`${e2eEnv.MOCK_URL}/__mock/next-login`, {
    method: "POST",
    body: JSON.stringify(login),
  });
}

async function signIn(page: Page, sub = ADA, companyId = "cmp-alpha") {
  await nextLogin({ sub, companyId });
  await page.goto("/");
  await page.getByTestId("sign-in").click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Hello");
}

async function connectWorkspace(
  page: Page,
  slug: string,
  sub: string,
  companyId: string,
) {
  await nextLogin({ sub, companyId });
  await page.getByTestId(`connect-${slug}`).click();
  await expect(
    page.getByTestId(`workspace-${slug}`).getByTestId("grant"),
  ).toHaveCount(1);
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
  await db.query(
    'TRUNCATE bexio_grants, "session", "account", "verification", "user" CASCADE',
  );
});

test.afterAll(async () => {
  await db.end();
});

test("sign in with Bexio: the grant is saved, Better Auth keeps no tokens, disconnect removes it", async ({
  page,
}) => {
  await signIn(page);
  const own = page.getByTestId(/^grants-(?!workspace)/);
  await expect(own.getByTestId("grant")).toContainText("Alpha AG");
  await expect(own.getByTestId("grant")).toContainText("(admin)");
  await expect(own.getByTestId("api-result")).toHaveText(
    "API call OK: Alpha AG",
  );

  const { rows: accounts } = await db.query(
    `SELECT "accessToken", "refreshToken", "idToken" FROM "account" WHERE "providerId" = 'bexio'`,
  );
  expect(accounts).toEqual([
    { accessToken: null, refreshToken: null, idToken: null },
  ]);
  const { rows: grants } = await db.query(
    "SELECT access_token, refresh_token FROM bexio_grants",
  );
  expect(grants).toHaveLength(1);
  // JWE compact serialization: five dot-separated parts, not a readable JWT.
  expect(grants[0].access_token.split(".")).toHaveLength(5);
  expect(grants[0].refresh_token.split(".")).toHaveLength(5);

  await own.getByTestId("disconnect").click();
  await expect(own).toHaveText("Not connected.");
});

test("connect Bexio for a workspace, use it from a background job, keep it alive with refreshIdle", async ({
  page,
  request,
}) => {
  await signIn(page);
  await connectWorkspace(page, "a", GRACE, "cmp-alpha");
  const ws = page.getByTestId("workspace-a");
  await expect(ws.getByTestId("grant")).toContainText("(member)");
  await expect(ws.getByTestId("api-result")).toHaveText(
    "API call OK: Alpha AG",
  );

  // No session: the job only knows the owner id.
  const job = await request.get("/api/jobs/sync?owner=workspace:a", {
    headers: cron,
  });
  expect(await job.json()).toMatchObject({ ok: true, company: "Alpha AG" });
  expect((await request.get("/api/jobs/sync?owner=workspace:a")).status()).toBe(
    401,
  );

  await page.waitForTimeout(1_500); // BEXIO_IDLE_FOR is 1s in e2e
  const sweep = await request.get("/api/cron/refresh-idle", { headers: cron });
  expect(await sweep.json()).toMatchObject({ reauthRequired: 0, failed: 0 });
  expect((await sweep.json()).refreshed).toBeGreaterThanOrEqual(1);
});

test("two workspaces connect the same Bexio user and company; disconnecting one keeps the other", async ({
  page,
}) => {
  await signIn(page);
  await connectWorkspace(page, "a", ADA, "cmp-beta");
  await connectWorkspace(page, "b", ADA, "cmp-beta");
  await page.getByTestId("workspace-a").getByTestId("disconnect").click();
  await expect(page.getByTestId("workspace-a")).toContainText("Not connected.");
  await expect(
    page.getByTestId("workspace-b").getByTestId("api-result"),
  ).toHaveText("API call OK: Beta GmbH");
});

test("a revoked Bexio session shows 'reconnect required', and reconnecting restores the grant", async ({
  page,
  request,
}) => {
  await signIn(page);
  await connectWorkspace(page, "b", GRACE, "cmp-alpha");
  await fetch(`${e2eEnv.MOCK_URL}/__mock/revoke-sessions`, {
    method: "POST",
    body: JSON.stringify({ sub: GRACE }),
  });
  await page.waitForTimeout(1_500);
  const sweep = await request.get("/api/cron/refresh-idle", { headers: cron });
  expect((await sweep.json()).reauthRequired).toBeGreaterThanOrEqual(1);

  await page.reload();
  const ws = page.getByTestId("workspace-b");
  await expect(ws.getByTestId("grant")).toHaveAttribute(
    "data-status",
    "reauth_required",
  );
  await expect(ws.getByTestId("api-result")).toHaveText("Reconnect required");

  await nextLogin({ sub: GRACE, companyId: "cmp-alpha" });
  await page.getByTestId("connect-b").click();
  await expect(ws.getByTestId("grant")).toHaveAttribute(
    "data-status",
    "active",
  );
  await expect(ws.getByTestId("api-result")).toHaveText(
    "API call OK: Alpha AG",
  );
});

test("a cancelled connect returns with the error code and saves nothing", async ({
  page,
}) => {
  await signIn(page);
  await nextLogin({ error: "access_denied" });
  await page.getByTestId("connect-a").click();
  await expect(page.getByTestId("bexio-error")).toContainText("access_denied");
  await expect(page.getByTestId("workspace-a")).toContainText("Not connected.");
});
