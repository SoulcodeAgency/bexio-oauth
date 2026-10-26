import { expect, test, type Locator } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { e2eEnv } from "../playwright.config";

/** The sample API call succeeded, and Bexio answered for this company. */
async function expectApiOk(result: Locator, company: string) {
  await expect(result).toHaveText("API OK");
  await expect(result).toHaveAttribute("data-company", company);
}

const db = new pg.Pool({ connectionString: e2eEnv.DATABASE_URL });

test.afterAll(async () => {
  await db.end();
});

test("connect Bexio for a Supabase user; RLS keeps the token tables unreadable for clients", async ({
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

  // The grant exists (server-side connection)…
  const anon = createClient(
    e2eEnv.NEXT_PUBLIC_SUPABASE_URL,
    e2eEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  const { data: signedIn } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  const userId = signedIn.user!.id;
  const { rows } = await db.query(
    "SELECT id FROM bexio_grants WHERE owner_id = $1",
    [userId],
  );
  expect(rows).toHaveLength(1);

  // …but neither the anon nor the signed-in user's role can read the tables
  // through the API. RLS without policies + REVOKE: PostgREST refuses
  // outright (42501), no rows leak.
  const signedOut = createClient(
    e2eEnv.NEXT_PUBLIC_SUPABASE_URL,
    e2eEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  for (const table of ["bexio_connections", "bexio_grants"]) {
    for (const api of [anon, signedOut]) {
      const result = await api.from(table).select("id");
      expect(result.data).toBeNull();
      expect(result.error?.code).toBe("42501");
    }
  }

  await page.getByTestId("disconnect").click();
  await expect(page.getByTestId("grants")).toHaveText("Not connected.");
});
