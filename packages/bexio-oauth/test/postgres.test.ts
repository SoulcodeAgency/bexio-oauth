import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
} from "vitest";
import pg from "pg";
import type { MockBexio } from "mock-bexio";
import {
  migrations,
  postgresStore,
  type GrantUpsert,
  type SqlClient,
} from "../src/index.js";
import { storeContract } from "./store-contract.js";
import {
  ADA,
  GRACE,
  KATHERINE,
  client,
  connect,
  freshDatabase,
  hasDatabase,
  mockBexio,
  testClock,
} from "./helpers.js";

it("postgresStore checks the schema name once, at construction", () => {
  const sql: SqlClient = {
    query: () => Promise.reject(new Error("no query expected")),
  };
  for (const schema of [
    "",
    "public",
    "Bexio",
    "1abc",
    "pg_catalog",
    'x"; DROP TABLE y; --',
    "a".repeat(64),
  ]) {
    expect(() => postgresStore(sql, { schema })).toThrow(
      expect.objectContaining({ code: "invalid_config" }),
    );
  }
  expect(() => postgresStore(sql, { schema: "a".repeat(63) })).not.toThrow();
});

it("postgresStore names its tables with the schema, quoted, in every statement", async () => {
  const statements: string[] = [];
  const store = postgresStore(
    {
      query: async (text) => {
        statements.push(text);
        return { rows: [] };
      },
    },
    { schema: "app_tokens" },
  );
  await store.getConnection("8f1c2a8e-0001-4000-8000-000000000001");
  await store.findGrants({ ownerId: "o" });
  await store.listIdleConnections({ refreshedBefore: new Date(), limit: 1 });
  for (const text of statements) {
    const tables = text.match(/(?:\S+\.)?bexio_(?:connections|grants)\b/g);
    expect(tables?.length).toBeGreaterThan(0);
    for (const t of tables!) expect(t).toMatch(/^"app_tokens"\.bexio_/);
  }
  expect(statements.join()).toContain('"app_tokens".bexio_grants');
});

it("postgresStore accepts a pg Pool and Client as SqlClient", () => {
  expectTypeOf<pg.Pool>().toExtend<SqlClient>();
  expectTypeOf<pg.Client>().toExtend<SqlClient>();
});

const upsert = (ownerId: string, now = new Date()): GrantUpsert => ({
  ownerId,
  companyId: "c",
  userId: "u",
  companyUserId: null,
  companyName: null,
  userName: null,
  userEmail: null,
  role: "member",
  accessToken: "a",
  refreshToken: "r",
  accessExpiresAt: now,
  refreshExpiresAt: null,
  scope: null,
  authorizedAt: now,
  now,
});

/** Slows the token endpoint, so every caller arrives while the first refresh is in flight. */
const slowTokenEndpoint: typeof fetch = async (input, init) => {
  if (String(input instanceof Request ? input.url : input).endsWith("/token"))
    await new Promise((r) => setTimeout(r, 300));
  return fetch(input, init);
};

describe.skipIf(!hasDatabase)("postgres", () => {
  let db: NonNullable<Awaited<ReturnType<typeof freshDatabase>>>;
  let mock: MockBexio;

  beforeAll(async () => {
    db = (await freshDatabase())!;
    mock = await mockBexio();
  });
  afterAll(async () => {
    await mock?.close();
    await db?.close();
  });
  beforeEach(async () => {
    await db.truncate();
  });

  storeContract("postgres", async () => {
    await db.truncate();
    return db.store();
  });

  /** A second pool with its connections opened up front, so calls on it really run in parallel. */
  async function warmPools() {
    const poolB = db.newPool();
    await Promise.all(
      Array.from({ length: 5 }).flatMap(() => [
        db.pool.query("SELECT 1"),
        poolB.query("SELECT 1"),
      ]),
    );
    return poolB;
  }

  it("every store operation is a single SQL statement", async () => {
    const calls: string[] = [];
    const recording: SqlClient = {
      query: (text, params) => {
        calls.push(text);
        return db.pool.query(text, params);
      },
    };
    const store = db.store(recording);
    const now = new Date();
    const count = async (op: () => Promise<unknown>) => {
      calls.length = 0;
      await op();
      return calls.length;
    };
    let grantId = "";
    let id = "";
    expect(
      await count(async () => {
        const grant = await store.upsertGrant(upsert("o", now));
        grantId = grant.id;
        id = grant.connection.id;
      }),
    ).toBe(1);
    expect(await count(() => store.findGrants({ ownerId: "o" }))).toBe(1);
    expect(await count(() => store.getConnection(id))).toBe(1);
    expect(
      await count(() =>
        store.acquireRefreshLock({
          id,
          now,
          lockUntil: now,
          lockToken: "t",
          accessExpiresBefore: now,
        }),
      ),
    ).toBe(1);
    expect(
      await count(() =>
        store.saveRefreshed(id, "t", {
          accessToken: "a2",
          refreshToken: null,
          accessExpiresAt: now,
          refreshExpiresAt: null,
          scope: null,
          role: null,
          now,
        }),
      ),
    ).toBe(1);
    expect(await count(() => store.releaseRefreshLock(id, "t"))).toBe(1);
    expect(await count(() => store.markReauthRequired(id, "t", now))).toBe(1);
    expect(
      await count(() =>
        store.listIdleConnections({ refreshedBefore: now, limit: 5 }),
      ),
    ).toBe(1);
    expect(await count(() => store.deleteGrant(grantId))).toBe(1);
    expect(await count(() => store.deleteUnusedConnection(id))).toBe(1);
  });

  it("a concurrent connect keeps the connection a last disconnect is deleting", async () => {
    const store = db.store();
    const first = await store.upsertGrant(upsert("owner-a"));
    await store.deleteGrant(first.id);
    // Another owner connects the same identity in a transaction that has
    // locked the connection row and added its grant, but not committed yet.
    const tx = await db.pool.connect();
    try {
      await tx.query("BEGIN");
      await db.store(tx).upsertGrant(upsert("owner-b"));
      const deleting = store.deleteUnusedConnection(first.connection.id);
      // Wait until the delete blocks on the row lock. Its snapshot predates
      // owner-b's grant, so only the foreign key can stop it.
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const { rows } = await db.admin.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query LIKE $1`,
          [`%DELETE FROM ${db.table("bexio_connections")}%`],
        );
        blocked = rows.length > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 20));
      }
      expect(blocked).toBe(true);
      await tx.query("COMMIT");
      expect(await deleting).toBeNull();
    } finally {
      tx.release();
    }
    expect(await store.getConnection(first.connection.id)).not.toBeNull();
    expect(await store.findGrants({ ownerId: "owner-b" })).toHaveLength(1);
  });

  it("getAccessToken with a valid token runs exactly one SELECT and no network call", async () => {
    const calls: string[] = [];
    const store = db.store({
      query: (text, params) => {
        calls.push(text.trim().split(/\s+/)[0]!);
        return db.pool.query(text, params);
      },
    });
    const bexio = client(mock, store);
    await connect(bexio, mock, "ws-1");
    calls.length = 0;
    const before = JSON.stringify(mock.stats);
    await bexio.getAccessToken({ ownerId: "ws-1" });
    expect(calls).toEqual(["SELECT"]);
    expect(JSON.stringify(mock.stats)).toBe(before);
  });

  it("single-flight: 5 concurrent refreshes across 2 instances hit the token endpoint once", async () => {
    const clock = testClock();
    const poolB = await warmPools();
    const options = { clock: clock.now, fetch: slowTokenEndpoint };
    const a = client(mock, db.store(), options);
    const b = client(mock, db.store(poolB), options);
    await connect(a, mock, "ws-1", { sub: ADA, companyId: "cmp-alpha" });
    clock.advance(10 * 60_000);

    const before = mock.stats.refreshTokenGrants;
    const results = await Promise.all([
      a.getAccessToken({ ownerId: "ws-1" }),
      b.getAccessToken({ ownerId: "ws-1" }),
      a.getAccessToken({ ownerId: "ws-1" }),
      b.getAccessToken({ ownerId: "ws-1" }),
      a.getAccessToken({ ownerId: "ws-1" }),
    ]);
    expect(mock.stats.refreshTokenGrants - before).toBe(1);
    expect(new Set(results.map((r) => r.accessToken)).size).toBe(1);
    // The session survived: no refresh token was reused.
    expect((await a.listGrants({ ownerId: "ws-1" }))[0]!.status).toBe("active");
  });

  it("single-flight across owners: 5 concurrent calls for 2 owners of one identity, on 2 instances, refresh once", async () => {
    const clock = testClock();
    const poolB = await warmPools();
    const options = { clock: clock.now, fetch: slowTokenEndpoint };
    const a = client(mock, db.store(), options);
    const b = client(mock, db.store(poolB), options);
    const login = { sub: ADA, companyId: "cmp-alpha" };
    await connect(a, mock, "ws-1", login);
    await connect(b, mock, "ws-2", login);
    clock.advance(10 * 60_000);

    const before = mock.stats.refreshTokenGrants;
    const rejected = mock.stats.rejectedRefreshes;
    const results = await Promise.all([
      a.getAccessToken({ ownerId: "ws-1" }),
      b.getAccessToken({ ownerId: "ws-2" }),
      b.getAccessToken({ ownerId: "ws-1" }),
      a.getAccessToken({ ownerId: "ws-2" }),
      a.getAccessToken({ ownerId: "ws-1" }),
    ]);
    expect(mock.stats.refreshTokenGrants - before).toBe(1);
    expect(mock.stats.rejectedRefreshes).toBe(rejected);
    expect(new Set(results.map((r) => r.accessToken)).size).toBe(1);
    expect(new Set(results.map((r) => r.grant.ownerId))).toEqual(
      new Set(["ws-1", "ws-2"]),
    );
  });

  it("a lock left behind by a crashed holder expires, and the next caller refreshes", async () => {
    const clock = testClock();
    const bexio = client(mock, db.store(), {
      clock: clock.now,
      refreshLockTtl: "30s",
    });
    const { grant } = await connect(bexio, mock, "ws-1", { sub: GRACE });
    await connect(bexio, mock, "ws-2", { sub: GRACE });
    clock.advance(10 * 60_000);
    // Simulate a holder that took the lock and died.
    await db.admin.query(
      `UPDATE ${db.table("bexio_connections")} SET refresh_locked_until = $2, refresh_lock_token = 'dead' WHERE id = $1`,
      [grant.connectionId, new Date(clock.now().getTime() + 2_000)],
    );
    const before = mock.stats.refreshTokenGrants;
    const pending = Promise.all([
      bexio.getAccessToken({ ownerId: "ws-1" }),
      bexio.getAccessToken({ ownerId: "ws-2" }),
    ]);
    setTimeout(() => clock.advance(3_000), 300);
    const [one, two] = await pending;
    expect(one.accessToken).toBe(two.accessToken);
    expect(mock.stats.refreshTokenGrants - before).toBe(1);
  });

  it("refreshIdle against Postgres", async () => {
    const clock = testClock();
    const bexio = client(mock, db.store(), { clock: clock.now });
    await connect(bexio, mock, "idle", { sub: GRACE });
    clock.advance(8 * 86_400_000);
    await connect(bexio, mock, "fresh", { sub: ADA, companyId: "cmp-beta" });
    expect(await bexio.refreshIdle({ idleFor: "7d" })).toEqual({
      refreshed: 1,
      skipped: 0,
      reauthRequired: 0,
      failed: 0,
      remaining: 0,
    });
  });

  describe("roles", () => {
    /** The SQLSTATE a statement fails with, or null if it succeeds. */
    const sqlState = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: { code?: string }) => e.code ?? "no code",
      );

    it("the store role finds the tables without the schema in its search_path", async () => {
      const { rows } = await db.pool.query<{ search_path: string }>(
        "SHOW search_path",
      );
      expect(rows[0]!.search_path).not.toContain(db.schema);
      expect(await sqlState(db.pool.query("SELECT 1 FROM bexio_grants"))).toBe(
        "42P01", // undefined_table
      );
      // …and can't create anything in the schema.
      expect(
        await sqlState(
          db.pool.query(`CREATE TABLE "${db.schema}".extra (id int)`),
        ),
      ).toBe("42501");
    });

    it("any other role can't reach the schema", async () => {
      const tx = await db.admin.connect();
      try {
        await tx.query("BEGIN");
        await tx.query("CREATE ROLE t_outsider");
        await tx.query("SET LOCAL ROLE t_outsider");
        expect(
          await sqlState(
            tx.query(`SELECT 1 FROM ${db.table("bexio_connections")}`),
          ),
        ).toBe("42501");
      } finally {
        await tx.query("ROLLBACK");
        tx.release();
      }
    });

    it("the SQL refuses an existing role of the chosen name unless it is a plain login role", async () => {
      const id = db.schema.slice(2, 14);
      const schema = `t_${id}_preexisting`;
      const cases: [string, string, string | null][] = [
        ["plain", "LOGIN PASSWORD 'x'", null], // what a user may pre-create
        ["nologin", "NOLOGIN", "P0001"],
        ["bypass", "LOGIN BYPASSRLS", "P0001"],
        ["createrole", "LOGIN CREATEROLE", "P0001"],
        ["member", "LOGIN IN ROLE pg_read_all_data", "P0001"],
      ];
      const tx = await db.admin.connect();
      try {
        await tx.query("BEGIN");
        for (const [suffix, attributes, expected] of cases) {
          const role = `t_${id}_${suffix}`;
          await tx.query(`CREATE ROLE "${role}" ${attributes}`);
          for (const options of [
            { schema, storeRole: role },
            { schema, storeRole: `${role}_s`, tokenRole: role },
          ]) {
            await tx.query("SAVEPOINT attempt");
            const [m] = await migrations(options);
            expect(await sqlState(tx.query(m!.sql)), suffix).toBe(expected);
            await tx.query("ROLLBACK TO SAVEPOINT attempt");
          }
        }
      } finally {
        await tx.query("ROLLBACK");
        tx.release();
      }
    });

    it("the token role gets, lists and refreshes tokens, but can't connect, disconnect or rewrite an identity", async () => {
      const clock = testClock();
      const full = client(mock, db.store(), { clock: clock.now });
      const tokenPool = db.tokenPool();
      const tokens = client(mock, db.store(tokenPool), { clock: clock.now });
      const { grant } = await connect(full, mock, "ws-1", { sub: GRACE });

      clock.advance(10 * 60_000); // expired: getAccessToken refreshes
      const before = mock.stats.refreshTokenGrants;
      const { accessToken } = await tokens.getAccessToken({ ownerId: "ws-1" });
      expect(mock.stats.refreshTokenGrants - before).toBe(1);
      expect(accessToken).toBeTruthy();
      expect(await tokens.listGrants({ ownerId: "ws-1" })).toHaveLength(1);
      clock.advance(8 * 86_400_000);
      expect((await tokens.refreshIdle({ idleFor: "7d" })).refreshed).toBe(1);

      expect(
        await sqlState(connect(tokens, mock, "ws-2", { sub: KATHERINE })),
      ).toBe("42501");
      expect(await sqlState(tokens.disconnect({ ownerId: "ws-1" }))).toBe(
        "42501",
      );
      expect(
        await sqlState(
          tokenPool.query(
            `UPDATE ${db.table("bexio_connections")} SET bexio_user_id = 'other' WHERE id = $1`,
            [grant.connectionId],
          ),
        ),
      ).toBe("42501");
      expect(await full.listGrants({ ownerId: "ws-1" })).toHaveLength(1);
    });

    it("the token role releases the lock after a failed refresh, and marks a dead session", async () => {
      const clock = testClock();
      const full = client(mock, db.store(), { clock: clock.now });
      await connect(full, mock, "ws-1", { sub: KATHERINE });
      clock.advance(10 * 60_000);
      const tokenStore = db.store(db.tokenPool());

      // Bexio unreachable for the token request: releaseRefreshLock.
      const offline = client(mock, tokenStore, {
        clock: clock.now,
        fetch: async (input, init) => {
          const url = String(input instanceof Request ? input.url : input);
          if (url.endsWith("/token")) throw new TypeError("fetch failed");
          return fetch(input, init);
        },
      });
      await expect(
        offline.getAccessToken({ ownerId: "ws-1" }),
      ).rejects.toMatchObject({ code: "idp_error" });
      const { rows } = await db.admin.query<{
        refresh_locked_until: Date | null;
      }>(`SELECT refresh_locked_until FROM ${db.table("bexio_connections")}`);
      expect(rows[0]!.refresh_locked_until).toBeNull();

      // Session revoked at Bexio: markReauthRequired.
      mock.revokeSessions(KATHERINE);
      const tokens = client(mock, tokenStore, { clock: clock.now });
      await expect(
        tokens.getAccessToken({ ownerId: "ws-1" }),
      ).rejects.toMatchObject({ code: "reauth_required" });
      expect((await full.listGrants({ ownerId: "ws-1" }))[0]!.status).toBe(
        "reauth_required",
      );
    });

    it("a second token role on the same schema leaves the first one's access intact", async () => {
      const full = client(mock, db.store());
      await connect(full, mock, "ws-1", { sub: GRACE });
      for (const pool of [db.tokenPool(), db.secondTokenPool()]) {
        const tokens = client(mock, db.store(pool));
        expect(await tokens.listGrants({ ownerId: "ws-1" })).toHaveLength(1);
      }
    });
  });
});
