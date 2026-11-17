import { randomUUID } from "node:crypto";
import pg from "pg";
import { startMockBexio, type MockBexio, type NextLogin } from "mock-bexio";
import {
  createBexioOAuth,
  generateKey,
  migrations,
  postgresStore,
  type BexioOAuthConfig,
  type GrantStore,
  type SqlClient,
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
 * The shipped migrations, applied twice (they must be idempotent) with a
 * fresh schema and fresh store and token roles, then once more with a second
 * token role (each role must keep its own policies), so every test file gets
 * empty tables. `pool` connects as the store role with its default
 * `search_path`, which doesn't include the schema: the store must name it in
 * every statement.
 */
export async function freshDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const id = randomUUID().replaceAll("-", "").slice(0, 20);
  const schema = `t_${id}`;
  const storeRole = `t_${id}_store`;
  const tokenRole = `t_${id}_token`;
  const secondTokenRole = `t_${id}_token2`;
  const roles = [storeRole, tokenRole, secondTokenRole];
  const password = randomUUID();
  const admin = new pg.Pool({ connectionString: url, max: 2 });
  for (const role of [tokenRole, tokenRole, secondTokenRole]) {
    for (const m of await migrations({ schema, storeRole, tokenRole: role }))
      await admin.query(m.sql);
  }
  for (const role of roles)
    await admin.query(`ALTER ROLE "${role}" PASSWORD '${password}'`);

  const pools: pg.Pool[] = [];
  const makePool = (role = storeRole) => {
    const login = new URL(url);
    login.username = role;
    login.password = password;
    const p = new pg.Pool({ connectionString: login.toString(), max: 5 });
    pools.push(p);
    return p;
  };
  const pool = makePool();
  /** `schema.table`, for raw queries. */
  const table = (name: "bexio_connections" | "bexio_grants") =>
    `"${schema}".${name}`;
  return {
    schema,
    pool,
    /** Superuser pool, for test setup and inspection. */
    admin,
    table,
    /** A store on `client` (default: `pool`) for this schema. */
    store: (client: SqlClient = pool) => postgresStore(client, { schema }),
    /** An independent pool as the store role (a second "instance"). */
    newPool: () => makePool(),
    /** A pool as the token role (`getAccessToken`, `listGrants`, `refreshIdle` only). */
    tokenPool: () => makePool(tokenRole),
    /** A pool as the second token role, set up after the first. */
    secondTokenPool: () => makePool(secondTokenRole),
    async truncate() {
      await admin.query(
        `TRUNCATE ${table("bexio_grants")}, ${table("bexio_connections")}`,
      );
    },
    async close() {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      for (const role of roles) await admin.query(`DROP ROLE "${role}"`);
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
