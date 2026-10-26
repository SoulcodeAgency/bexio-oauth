import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { e2eEnv } from "../playwright.config";

const ADA = "8f1c2a8e-0001-4000-8000-000000000001";
const GRACE = "8f1c2a8e-0002-4000-8000-000000000002";
const cron = { Authorization: `Bearer ${e2eEnv.CRON_SECRET}` };

const db = new pg.Pool({ connectionString: e2eEnv.DATABASE_URL });
type Row = { id: string; access_token: string };

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

async function mockStats(): Promise<{ revocations: number }> {
  const res = await fetch(`${e2eEnv.MOCK_URL}/__mock/stats`);
  return (await res.json()) as { revocations: number };
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
    'TRUNCATE bexio_grants, bexio_connections, "session", "account", "verification", "user" CASCADE',
  );
});

test.afterAll(async () => {
  await db.end();
});

test("sign in with Bexio: the grant is saved, Better Auth keeps no tokens, disconnect removes it", async ({
  page,
}) => {
  await signIn(page);
  // Bexio sends no name claim; the app maps given_name and family_name.
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Hello Ada Lovelace",
  );
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
  const { rows: connections } = await db.query<{
    access_token: string;
    refresh_token: string;
  }>("SELECT access_token, refresh_token FROM bexio_connections");
  expect(connections).toHaveLength(1);
  // JWE compact serialization: five dot-separated parts, not a readable JWT.
  expect(connections[0].access_token.split(".")).toHaveLength(5);
  expect(connections[0].refresh_token.split(".")).toHaveLength(5);

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

  const lastRefreshed = async () =>
    (
      await db.query<{ last_refreshed_at: Date }>(
        `SELECT c.last_refreshed_at FROM bexio_grants g
         JOIN bexio_connections c ON c.id = g.connection_id
         WHERE g.owner_id = 'workspace:a'`,
      )
    ).rows[0].last_refreshed_at;
  const before = await lastRefreshed();
  await page.waitForTimeout(1_500); // BEXIO_IDLE_FOR is 1s in e2e
  const sweep = await request.get("/api/cron/refresh-idle", { headers: cron });
  expect(await sweep.json()).toMatchObject({ reauthRequired: 0, failed: 0 });
  // The workspace grant itself was refreshed, not just the user's own one.
  expect((await lastRefreshed()).getTime()).toBeGreaterThan(before.getTime());
});

test("signing in again replaces the tokens: still one grant, Better Auth's copy cleared again", async ({
  page,
}) => {
  await signIn(page);
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("sign-in")).toBeVisible();
  const { rows: first } = await db.query<Row>(
    "SELECT g.id, c.access_token FROM bexio_grants g JOIN bexio_connections c ON c.id = g.connection_id",
  );
  // A user saved without a name gets it from Bexio on the next sign-in.
  await db.query(`UPDATE "user" SET name = ''`);
  await signIn(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Hello Ada Lovelace",
  );
  const { rows: second } = await db.query<Row>(
    "SELECT g.id, c.access_token FROM bexio_grants g JOIN bexio_connections c ON c.id = g.connection_id",
  );
  expect(second).toHaveLength(1);
  expect(second[0].id).toBe(first[0].id);
  expect(second[0].access_token).not.toBe(first[0].access_token);
  const { rows: accounts } = await db.query(
    `SELECT "accessToken", "refreshToken", "idToken" FROM "account" WHERE "providerId" = 'bexio'`,
  );
  expect(accounts).toEqual([
    { accessToken: null, refreshToken: null, idToken: null },
  ]);
});

test("two workspaces connect the same Bexio user and company; both keep working through refreshes and a disconnect", async ({
  page,
  request,
}) => {
  // Sign in as another Bexio user, so only the workspaces share Ada's identity.
  await signIn(page, GRACE);
  await connectWorkspace(page, "a", ADA, "cmp-beta");
  await connectWorkspace(page, "b", ADA, "cmp-beta");
  const apiResult = (slug: string) =>
    page.getByTestId(`workspace-${slug}`).getByTestId("api-result");

  // Refresh every idle connection, workspace a's included. Its authorization
  // is the older one: Bexio restarted the token chain when b connected.
  const refreshIdle = async () => {
    await page.waitForTimeout(1_500); // BEXIO_IDLE_FOR is 1s in e2e
    const sweep = await request.get("/api/cron/refresh-idle", {
      headers: cron,
    });
    return (await sweep.json()) as Record<string, number>;
  };
  // Counts connections: Grace's own, and the one both workspaces share.
  expect(await refreshIdle()).toMatchObject({
    refreshed: 2,
    reauthRequired: 0,
    failed: 0,
  });
  await page.reload();
  await expect(apiResult("a")).toHaveText("API call OK: Beta GmbH");
  await expect(apiResult("b")).toHaveText("API call OK: Beta GmbH");

  // Disconnecting a revokes nothing at Bexio: b still uses the chain.
  const { revocations } = await mockStats();
  await page.getByTestId("workspace-a").getByTestId("disconnect").click();
  await expect(page.getByTestId("workspace-a")).toContainText("Not connected.");
  expect((await mockStats()).revocations).toBe(revocations);

  // Grace's own connection and the one b still uses.
  expect(await refreshIdle()).toMatchObject({
    refreshed: 2,
    reauthRequired: 0,
    failed: 0,
  });
  await page.reload();
  await expect(apiResult("b")).toHaveText("API call OK: Beta GmbH");
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
  const sweepResult = (await sweep.json()) as { reauthRequired: number };
  expect(sweepResult.reauthRequired).toBeGreaterThanOrEqual(1);

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

test("test tools: revoking a saved, stale token ends the current chain", async ({
  page,
}) => {
  await signIn(page, GRACE);
  await connectWorkspace(page, "a", ADA, "cmp-beta");
  const ws = page.getByTestId("workspace-a");
  await ws.getByTestId("tool-save").click();
  await expect(ws.getByTestId("tool-revoke-saved")).toBeVisible();

  // Reconnecting makes the saved refresh token stale.
  await nextLogin({ sub: ADA, companyId: "cmp-beta" });
  await page.getByTestId("connect-a").click();
  await expect(ws.getByTestId("api-result")).toHaveText(
    "API call OK: Beta GmbH",
  );

  const { revocations } = await mockStats();
  await ws.getByTestId("tool-revoke-saved").click();
  await expect(ws.getByTestId("tool-revoke-saved")).toHaveCount(0);
  await expect
    .poll(async () => (await mockStats()).revocations)
    .toBe(revocations + 1);
  // Force a refresh: the revocation ended the current chain too.
  // The action re-renders the page, which refreshes; wait for that render
  // rather than reloading, which could beat the action.
  await ws.getByTestId("tool-expire").click();
  await expect(ws.getByTestId("api-result")).toHaveText("Reconnect required");
  await page.reload();
  await expect(ws.getByTestId("grant")).toHaveAttribute(
    "data-status",
    "reauth_required",
  );

  // Reconnect right from the grant.
  await nextLogin({ sub: ADA, companyId: "cmp-beta" });
  await ws.getByTestId("reconnect").click();
  await expect(ws.getByTestId("api-result")).toHaveText(
    "API call OK: Beta GmbH",
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
