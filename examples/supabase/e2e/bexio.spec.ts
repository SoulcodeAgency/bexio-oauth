import { readdirSync, readFileSync } from "node:fs";
import { expect, test, type Locator } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { migrations } from "@soulcode/bexio-oauth";
import pg from "pg";
import { e2eEnv } from "../playwright.config";

/** The sample API call succeeded, and Bexio answered for this company. */
async function expectApiOk(result: Locator, company: string) {
  await expect(result).toHaveText("API OK");
  await expect(result).toHaveAttribute("data-company", company);
}

/** The stack's owner role, for setup and checks. */
const admin = new pg.Pool({ connectionString: e2eEnv.ADMIN_DATABASE_URL });
/** What the app connects as. */
const store = new pg.Pool({ connectionString: e2eEnv.DATABASE_URL });

test.afterAll(async () => {
  await Promise.all([admin.end(), store.end()]);
});

/** The SQLSTATE a statement fails with, or null if it succeeds. */
const sqlState = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: string }) => e.code ?? "no code",
  );

test("connect Bexio for a Supabase user; the token tables aren't reachable through the API", async ({
  page,
}) => {
  const email = `e2e-${Date.now()}@example.com`;
  const password = "e2e-password-123";
  await page.goto("/");
  await page.getByTestId("email").fill(email);
  await page.getByTestId("password").fill(password);
  await page.getByTestId("sign-in").click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(email);

  await fetch(`${e2eEnv.MOCK_URL}/__mock/next-login`, {
    method: "POST",
    body: JSON.stringify({
      sub: "8f1c2a8e-0001-4000-8000-000000000001",
      companyId: "cmp-alpha",
    }),
  });
  await page.getByTestId("connect").click();
  await expect(page.getByTestId("grant")).toContainText("Alpha AG");
  await expectApiOk(page.getByTestId("api-result"), "Alpha AG");

  // The grant exists (the app's bexio_store connection)…
  const signedIn = createClient(
    e2eEnv.NEXT_PUBLIC_SUPABASE_URL,
    e2eEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  const { data } = await signedIn.auth.signInWithPassword({ email, password });
  const userId = data.user!.id;
  const { rows } = await admin.query(
    "SELECT id FROM bexio_oauth.bexio_grants WHERE owner_id = $1",
    [userId],
  );
  expect(rows).toHaveLength(1);

  // …but the Data API doesn't serve the schema, signed in or not.
  const signedOut = createClient(
    e2eEnv.NEXT_PUBLIC_SUPABASE_URL,
    e2eEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  for (const table of ["bexio_connections", "bexio_grants"]) {
    for (const api of [signedIn, signedOut]) {
      const result = await api.schema("bexio_oauth").from(table).select("id");
      expect(result.data).toBeNull();
      expect(result.error).not.toBeNull();
    }
  }

  await page.getByTestId("disconnect").click();
  await expect(page.getByTestId("grants")).toHaveText("Not connected.");
});

test("the migration is the CLI's current output, and applies twice in a row", async () => {
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const [file] = readdirSync(dir).filter((f) => f.endsWith("_bexio_oauth.sql"));
  const sql = readFileSync(new URL(file, dir), "utf8");
  // Unedited `npx @soulcode/bexio-oauth sql` output: regenerate it when the
  // library's SQL changes.
  const cli = (await migrations())
    .map((m) => `-- ${m.name}\n${m.sql.trimEnd()}\n`)
    .join("\n");
  expect(sql.replace(/\r\n/g, "\n")).toBe(cli);
  // `supabase start` applied it once; twice more must change nothing.
  await admin.query(sql);
  await admin.query(sql);
});

test("bexio_store can't read anything outside its schema", async () => {
  expect(await sqlState(store.query("SELECT 1 FROM auth.users"))).toBe("42501");
  await admin.query("CREATE TABLE IF NOT EXISTS public.e2e_probe (id int)");
  try {
    expect(await sqlState(store.query("SELECT 1 FROM public.e2e_probe"))).toBe(
      "42501",
    );
  } finally {
    await admin.query("DROP TABLE public.e2e_probe");
  }
  // Its own tables it reaches by schema-qualified name, as the library does.
  expect(
    await sqlState(store.query("SELECT 1 FROM bexio_oauth.bexio_connections")),
  ).toBeNull();
});

test("the API roles can't read bexio_oauth, service_role included", async () => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const table of ["bexio_connections", "bexio_grants"]) {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${role}`);
        expect(
          await sqlState(client.query(`SELECT 1 FROM bexio_oauth.${table}`)),
          `${role} on ${table}`,
        ).toBe("42501");
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
  }
});
