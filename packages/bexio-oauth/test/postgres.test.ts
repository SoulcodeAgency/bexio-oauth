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
import { postgresStore, type SqlClient } from "../src/index.js";
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
    const base = {
      ownerId: "o",
      companyId: "c",
      userId: "u",
      companyUserId: null,
      companyName: null,
      userName: null,
      userEmail: null,
      role: "member" as const,
      accessToken: "a",
      refreshToken: "r",
      accessExpiresAt: now,
      refreshExpiresAt: null,
      scope: null,
      now,
    };
    let id = "";
    expect(
      await count(async () => (id = (await store.upsertGrant(base)).id)),
    ).toBe(1);
    expect(await count(() => store.findGrants({ ownerId: "o" }))).toBe(1);
    expect(await count(() => store.getGrant(id))).toBe(1);
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
        store.listIdleGrants({ refreshedBefore: now, limit: 5 }),
      ),
    ).toBe(1);
    expect(await count(() => store.deleteGrant(id))).toBe(1);
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
    // Slow token endpoint, so every caller arrives while the first refresh is in flight.
    const slowFetch: typeof fetch = async (input, init) => {
      if (
        String(input instanceof Request ? input.url : input).endsWith("/token")
      ) {
        await new Promise((r) => setTimeout(r, 300));
      }
      return fetch(input, init);
    };
    const poolB = db.newPool();
    // Open connections up front, so the five calls really run in parallel.
    await Promise.all(
      [...Array(5)].flatMap(() => [
        db.pool.query("SELECT 1"),
        poolB.query("SELECT 1"),
      ]),
    );
    const a = client(mock, postgresStore(db.pool), {
      clock: clock.now,
      fetch: slowFetch,
    });
    const b = client(mock, postgresStore(poolB), {
      clock: clock.now,
      fetch: slowFetch,
    });
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

  it("a lock left behind by a crashed holder expires, and the next caller refreshes", async () => {
    const clock = testClock();
    const bexio = client(mock, postgresStore(db.pool), {
      clock: clock.now,
      refreshLockTtl: "2s",
    });
    const { grant } = await connect(bexio, mock, "ws-1", { sub: GRACE });
    clock.advance(10 * 60_000);
    // Simulate a holder that took the lock and died.
    await db.pool.query(
      "UPDATE bexio_grants SET refresh_locked_until = $2 WHERE id = $1",
      [grant.id, new Date(clock.now().getTime() + 2_000)],
    );
    const before = mock.stats.refreshTokenGrants;
    const pending = bexio.getAccessToken({ ownerId: "ws-1" });
    setTimeout(() => clock.advance(3_000), 300);
    await expect(pending).resolves.toBeTruthy();
    expect(mock.stats.refreshTokenGrants - before).toBe(1);
  });

  it("refreshIdle against Postgres", async () => {
    const clock = testClock();
    const bexio = client(mock, postgresStore(db.pool), { clock: clock.now });
    await connect(bexio, mock, "idle", { sub: ADA, companyId: "cmp-alpha" });
    clock.advance(8 * 86_400_000);
    await connect(bexio, mock, "fresh", { sub: ADA, companyId: "cmp-beta" });
    expect(await bexio.refreshIdle({ idleFor: "7d" })).toEqual({
      refreshed: 1,
      skipped: 0,
      reauthRequired: 0,
      failed: 0,
    });
  });
});
