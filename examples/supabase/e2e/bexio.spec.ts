import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { e2eEnv } from "../playwright.config";

const db = new pg.Pool({ connectionString: e2eEnv.DATABASE_URL });

test.afterAll(async () => {
  await db.end();
});

test("connect Bexio for a Supabase user; RLS keeps bexio_grants unreadable for clients", async ({
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
  await expect(page.getByTestId("api-result")).toHaveText(
    "API call OK: Alpha AG",
  );

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

  // …but neither the anon nor the signed-in user's role can read it through the API.
  const asUser = await anon.from("bexio_grants").select("id, access_token");
  expect(asUser.data ?? []).toEqual([]);
  const asAnon = await createClient(
    e2eEnv.NEXT_PUBLIC_SUPABASE_URL,
    e2eEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  )
    .from("bexio_grants")
    .select("id");
  expect(asAnon.data ?? []).toEqual([]);

  await page.getByTestId("disconnect").click();
  await expect(page.getByTestId("grants")).toHaveText("Not connected.");
});
