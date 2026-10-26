import { randomUUID } from "node:crypto";
import pg from "pg";
import { startMockBexio, type MockBexio, type NextLogin } from "mock-bexio";
import {
  createBexioOAuth,
  generateKey,
  migrations,
  type BexioOAuthConfig,
  type GrantStore,
} from "../src/index.js";

export const REDIRECT_URI = "http://localhost/api/bexio/callback";
export const ADA = "8f1c2a8e-0001-4000-8000-000000000001";
export const GRACE = "8f1c2a8e-0002-4000-8000-000000000002";
export const KATHERINE = "8f1c2a8e-0003-4000-8000-000000000003";

export const keys = { current: "k1", keys: { k1: generateKey() } };

/** A settable clock, so tests can move time forward without waiting. */
export function testClock(start = Date.now()) {
  let now = start;
  return {
    now: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

export async function mockBexio(): Promise<MockBexio> {
  return startMockBexio({
    clientId: "test-client",
    clientSecret: "test-secret",
  });
}

export function client(
  mock: MockBexio,
  store: GrantStore,
  overrides: Partial<BexioOAuthConfig> = {},
) {
  return createBexioOAuth({
    clientId: mock.clientId,
    clientSecret: mock.clientSecret,
    redirectUri: REDIRECT_URI,
    scopes: ["contact_show"],
    keys,
    store,
    issuer: mock.issuer,
    apiBaseUrl: mock.apiBaseUrl,
    ...overrides,
  });
}

type Client = ReturnType<typeof client>;

/** Cookie name=value pairs from a response's Set-Cookie headers. */
export function cookiesFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

/**
 * Runs `start`, lets the mock "log in", and returns the callback Request the
 * browser would send (URL from Bexio's redirect + the flow cookie).
 */
export async function authorize(
  bexio: Client,
  mock: MockBexio,
  ownerId: string,
  login: NextLogin = {},
  returnTo = "/settings",
): Promise<{ request: Request; start: Response }> {
  const start = await bexio.start({
    ownerId,
    returnTo,
  });
  mock.nextLogin(login);
  const auth = await fetch(start.headers.get("location")!, {
    redirect: "manual",
  });
  const callbackUrl = auth.headers.get("location")!;
  return {
    start,
    request: new Request(callbackUrl, {
      headers: { cookie: cookiesFrom(start) },
    }),
  };
}

export async function connect(
  bexio: Client,
  mock: MockBexio,
  ownerId: string,
  login: NextLogin = {},
) {
  const { request } = await authorize(bexio, mock, ownerId, login);
  return bexio.handleCallback(request, { ownerId });
}

/**
 * A pool on a fresh schema with the shipped migrations applied, so every test
 * file gets empty tables.
 */
export async function freshDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const schema = `t_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const makePool = () =>
    new pg.Pool({
      connectionString: url,
      max: 5,
      options: `-c search_path=${schema}`,
    });
  const pool = makePool();
  for (const m of await migrations()) await pool.query(m.sql);
  const pools = [pool];
  return {
    pool,
    /** An independent pool on the same schema (a second "instance"). */
    newPool() {
      const p = makePool();
      pools.push(p);
      return p;
    },
    async truncate() {
      await pool.query("TRUNCATE bexio_grants, bexio_connections");
    },
    async close() {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

/** Fails loudly in CI when Postgres isn't configured, instead of silently skipping. */
export const hasDatabase = (() => {
  if (process.env.DATABASE_URL) return true;
  if (process.env.CI)
    throw new Error("DATABASE_URL must be set in CI for integration tests");
  return false;
})();
