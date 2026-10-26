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
  postgresStore,
  type GrantUpsert,
  type SqlClient,
} from "../src/index.js";
import { storeContract } from "./store-contract.js";
import {
  ADA,
  GRACE,
  client,
  connect,
  freshDatabase,
  hasDatabase,
  mockBexio,
  testClock,
} from "./helpers.js";

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
    return postgresStore(db.pool);
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
    const store = postgresStore(recording);
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
    const store = postgresStore(db.pool);
    const first = await store.upsertGrant(upsert("owner-a"));
    await store.deleteGrant(first.id);
    // Another owner connects the same identity in a transaction that has
    // locked the connection row and added its grant, but not committed yet.
    const tx = await db.pool.connect();
    try {
      await tx.query("BEGIN");
      await postgresStore(tx).upsertGrant(upsert("owner-b"));
      const deleting = store.deleteUnusedConnection(first.connection.id);
      // Wait until the delete blocks on the row lock. Its snapshot predates
      // owner-b's grant, so only the foreign key can stop it.
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const { rows } = await db.pool.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query LIKE '%DELETE FROM bexio_connections%'`,
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
    const store = postgresStore({
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
    const a = client(mock, postgresStore(db.pool), options);
    const b = client(mock, postgresStore(poolB), options);
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
    const a = client(mock, postgresStore(db.pool), options);
    const b = client(mock, postgresStore(poolB), options);
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
    const bexio = client(mock, postgresStore(db.pool), {
      clock: clock.now,
      refreshLockTtl: "30s",
    });
    const { grant } = await connect(bexio, mock, "ws-1", { sub: GRACE });
    await connect(bexio, mock, "ws-2", { sub: GRACE });
    clock.advance(10 * 60_000);
    // Simulate a holder that took the lock and died.
    await db.pool.query(
      "UPDATE bexio_connections SET refresh_locked_until = $2, refresh_lock_token = 'dead' WHERE id = $1",
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
    const bexio = client(mock, postgresStore(db.pool), { clock: clock.now });
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
});
