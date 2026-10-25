import { beforeEach, describe, expect, it } from "vitest";
import type {
  ConnectionRefresh,
  GrantStore,
  GrantUpsert,
} from "../src/index.js";

const t0 = new Date("2026-03-01T10:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

function upsert(overrides: Partial<GrantUpsert> = {}): GrantUpsert {
  return {
    ownerId: "owner-1",
    companyId: "cmp-1",
    userId: "user-1",
    companyUserId: 3,
    companyName: "Alpha AG",
    userName: "Ada",
    userEmail: "ada@example.com",
    role: "member",
    accessToken: "enc-access",
    refreshToken: "enc-refresh",
    accessExpiresAt: at(300_000),
    refreshExpiresAt: null,
    scope: "openid",
    now: t0,
    ...overrides,
  };
}

const refresh = (
  overrides: Partial<ConnectionRefresh> = {},
): ConnectionRefresh => ({
  accessToken: "enc-access-2",
  refreshToken: null,
  accessExpiresAt: at(700_000),
  refreshExpiresAt: null,
  scope: null,
  role: null,
  now: at(400_000),
  ...overrides,
});

/** A lock request for a connection whose access token has expired at `at(400_000)`. */
const expired = (
  id: string,
  lockToken: string,
  nowMs = 400_000,
  ttl = 30_000,
) => ({
  id,
  now: at(nowMs),
  lockUntil: at(nowMs + ttl),
  lockToken,
  accessExpiresBefore: at(nowMs),
});

/**
 * Behavior every `GrantStore` must have. Run against `memoryStore` and
 * `postgresStore` so both stay interchangeable.
 */
export function storeContract(name: string, setup: () => Promise<GrantStore>) {
  describe(`${name} store contract`, () => {
    let store: GrantStore;
    beforeEach(async () => {
      store = await setup();
    });

    const statusOf = async (ownerId: string) =>
      (await store.findGrants({ ownerId }))[0]!.connection.status;

    it("upsert inserts a connection and a grant, then overwrites the same (owner, company, user)", async () => {
      const a = await store.upsertGrant(upsert());
      expect(a).toMatchObject({
        ownerId: "owner-1",
        createdAt: t0,
        connection: {
          companyId: "cmp-1",
          userId: "user-1",
          status: "active",
          lastRefreshedAt: t0,
          createdAt: t0,
        },
      });
      await store.acquireRefreshLock(expired(a.connection.id, "L1"));
      await store.markReauthRequired(a.connection.id, "L1", at(1));
      const b = await store.upsertGrant(
        upsert({ accessToken: "enc-access-2", role: "admin", now: at(5_000) }),
      );
      expect(b.id).toBe(a.id);
      expect(b).toMatchObject({
        createdAt: t0,
        connection: {
          id: a.connection.id,
          accessToken: "enc-access-2",
          role: "admin",
          status: "active",
          refreshLockedUntil: null,
          createdAt: t0,
          updatedAt: at(5_000),
        },
      });
      expect(await store.findGrants({ ownerId: "owner-1" })).toHaveLength(1);
    });

    it("owners of the same Bexio identity share one connection; other identities get their own", async () => {
      const a = await store.upsertGrant(upsert());
      const b = await store.upsertGrant(
        upsert({ ownerId: "owner-2", accessToken: "enc-b", now: at(1) }),
      );
      const other = await store.upsertGrant(
        upsert({ ownerId: "owner-2", companyId: "cmp-2", now: at(2) }),
      );
      expect(b.id).not.toBe(a.id);
      expect(b.createdAt).toEqual(at(1));
      expect(b.connection.id).toBe(a.connection.id);
      expect(other.connection.id).not.toBe(a.connection.id);
      // The connection holds the tokens once: owner-1 sees owner-2's connect.
      const [own] = await store.findGrants({ ownerId: "owner-1" });
      expect(own!.connection.accessToken).toBe("enc-b");
    });

    it("connecting any owner revives every owner of that identity", async () => {
      const a = await store.upsertGrant(upsert());
      await store.upsertGrant(upsert({ ownerId: "owner-2" }));
      await store.acquireRefreshLock(expired(a.connection.id, "L"));
      await store.markReauthRequired(a.connection.id, "L", at(1));
      expect(await statusOf("owner-1")).toBe("reauth_required");
      expect(await statusOf("owner-2")).toBe("reauth_required");
      await store.upsertGrant(upsert({ ownerId: "owner-2", now: at(2) }));
      expect(await statusOf("owner-1")).toBe("active");
      expect(await statusOf("owner-2")).toBe("active");
    });

    it("finds by owner, company and grant id, oldest first, with the connection", async () => {
      const a = await store.upsertGrant(upsert());
      const b = await store.upsertGrant(
        upsert({ companyId: "cmp-2", now: at(1) }),
      );
      await store.upsertGrant(upsert({ ownerId: "owner-2" }));
      expect(
        (await store.findGrants({ ownerId: "owner-1" })).map((g) => g.id),
      ).toEqual([a.id, b.id]);
      expect(
        await store.findGrants({ ownerId: "owner-1", companyId: "cmp-2" }),
      ).toEqual([b]);
      expect(
        await store.findGrants({ ownerId: "owner-1", grantId: a.id }),
      ).toEqual([
        {
          ...a,
          // owner-2's connect at t0 rewrote the shared connection.
          connection: (await store.getConnection(a.connection.id))!,
        },
      ]);
      expect(await store.findGrants({ ownerId: "nobody" })).toEqual([]);
      // Not a uuid: no row, no driver error.
      expect(
        await store.findGrants({ ownerId: "owner-1", grantId: "not-a-uuid" }),
      ).toEqual([]);
      expect(
        await store.getConnection("------------------------------------"),
      ).toBeNull();
    });

    it("deleteGrant removes one owner; the connection goes only once no grant uses it", async () => {
      const a = await store.upsertGrant(upsert());
      const b = await store.upsertGrant(upsert({ ownerId: "owner-2" }));
      expect(await store.deleteUnusedConnection(a.connection.id)).toBeNull();

      await store.deleteGrant(a.id);
      expect(await store.findGrants({ ownerId: "owner-1" })).toEqual([]);
      expect(await store.findGrants({ ownerId: "owner-2" })).toHaveLength(1);
      expect(await store.deleteUnusedConnection(a.connection.id)).toBeNull();
      expect(await store.getConnection(a.connection.id)).not.toBeNull();

      await store.deleteGrant(b.id);
      expect(await store.deleteUnusedConnection(a.connection.id)).toMatchObject(
        { id: a.connection.id, refreshToken: "enc-refresh" },
      );
      expect(await store.getConnection(a.connection.id)).toBeNull();
      expect(await store.deleteUnusedConnection(a.connection.id)).toBeNull();
    });

    it("refresh lock: one winner, honors the condition, expires", async () => {
      const { connection: c } = await store.upsertGrant(
        upsert({ accessExpiresAt: at(10_000) }),
      );
      // Not expiring yet → nothing to do.
      expect(
        await store.acquireRefreshLock({
          id: c.id,
          now: t0,
          lockUntil: at(30_000),
          lockToken: "L0",
          accessExpiresBefore: at(5_000),
        }),
      ).toBeNull();
      expect(
        await store.acquireRefreshLock(expired(c.id, "L1", 20_000)),
      ).toMatchObject({
        id: c.id,
        refreshLockedUntil: at(50_000),
      });
      expect(
        await store.acquireRefreshLock(expired(c.id, "L2", 20_000)),
      ).toBeNull();
      // After the lock expires, the next caller takes over.
      expect(
        await store.acquireRefreshLock(expired(c.id, "L3", 50_000)),
      ).toMatchObject({
        refreshLockedUntil: at(80_000),
      });
    });

    it("refresh lock by idle time", async () => {
      const { connection: c } = await store.upsertGrant(upsert());
      const req = { id: c.id, now: at(1), lockUntil: at(2), lockToken: "L" };
      expect(
        await store.acquireRefreshLock({ ...req, refreshedBefore: t0 }),
      ).toBeNull();
      expect(
        await store.acquireRefreshLock({ ...req, refreshedBefore: at(1) }),
      ).not.toBeNull();
    });

    it("saveRefreshed stores the rotation once for every owner, keeps nulls, releases the lock", async () => {
      const { connection: c } = await store.upsertGrant(upsert());
      await store.upsertGrant(upsert({ ownerId: "owner-2" }));
      await store.acquireRefreshLock(expired(c.id, "L1"));
      const saved = await store.saveRefreshed(
        c.id,
        "L1",
        refresh({ refreshToken: "enc-refresh-2" }),
      );
      const expected = {
        accessToken: "enc-access-2",
        refreshToken: "enc-refresh-2",
        scope: "openid",
        role: "member",
        refreshLockedUntil: null,
        lastRefreshedAt: at(400_000),
      };
      expect(saved).toMatchObject(expected);
      for (const ownerId of ["owner-1", "owner-2"]) {
        expect(
          (await store.findGrants({ ownerId }))[0]!.connection,
        ).toMatchObject(expected);
      }
    });

    it("fences holder writes: an expired or replaced lock changes nothing", async () => {
      const { connection: c } = await store.upsertGrant(upsert());
      await store.acquireRefreshLock(expired(c.id, "stale", 400_000, 1_000));
      // The stale holder's lock expires and a second caller takes over.
      await store.acquireRefreshLock(expired(c.id, "fresh", 402_000));
      expect(
        await store.saveRefreshed(c.id, "stale", refresh({ accessToken: "x" })),
      ).toBeNull();
      expect(
        await store.markReauthRequired(c.id, "stale", at(402_500)),
      ).toBeNull();
      await store.releaseRefreshLock(c.id, "stale");
      expect(await store.getConnection(c.id)).toMatchObject({
        accessToken: "enc-access",
        status: "active",
        refreshLockedUntil: at(432_000),
      });
      // The current holder still can.
      expect(await store.saveRefreshed(c.id, "fresh", refresh())).toMatchObject(
        { accessToken: "enc-access-2" },
      );
    });

    it("another owner's connect clears the lock, so the in-flight refresh can't clobber it", async () => {
      const { connection: c } = await store.upsertGrant(upsert());
      await store.acquireRefreshLock(expired(c.id, "L1"));
      await store.upsertGrant(
        upsert({
          ownerId: "owner-2",
          accessToken: "enc-reconnected",
          now: at(401_000),
        }),
      );
      expect(await store.saveRefreshed(c.id, "L1", refresh())).toBeNull();
      expect(
        await store.markReauthRequired(c.id, "L1", at(402_000)),
      ).toBeNull();
      expect(await store.getConnection(c.id)).toMatchObject({
        accessToken: "enc-reconnected",
        status: "active",
        refreshLockedUntil: null,
      });
    });

    it("markReauthRequired and releaseRefreshLock with the right token", async () => {
      const { connection: c } = await store.upsertGrant(upsert());
      await store.upsertGrant(upsert({ ownerId: "owner-2" }));
      await store.acquireRefreshLock(expired(c.id, "L1"));
      await store.releaseRefreshLock(c.id, "L1");
      expect((await store.getConnection(c.id))!.refreshLockedUntil).toBeNull();
      await store.acquireRefreshLock(expired(c.id, "L2"));
      expect(await store.markReauthRequired(c.id, "L2", at(1))).toMatchObject({
        status: "reauth_required",
        refreshLockedUntil: null,
        updatedAt: at(1),
      });
      expect(await statusOf("owner-1")).toBe("reauth_required");
      expect(await statusOf("owner-2")).toBe("reauth_required");
      // A reauth_required connection can't be locked for refresh.
      expect(await store.acquireRefreshLock(expired(c.id, "L3"))).toBeNull();
    });

    it("lists active idle connections with grants, once each, oldest first, with a limit", async () => {
      await store.upsertGrant(upsert({ userId: "a", now: at(2) }));
      await store.upsertGrant(
        upsert({ userId: "b", ownerId: "owner-1", now: at(1) }),
      );
      await store.upsertGrant(
        upsert({ userId: "b", ownerId: "owner-2", now: at(1) }),
      );
      const dead = await store.upsertGrant(upsert({ userId: "c", now: at(0) }));
      await store.acquireRefreshLock(expired(dead.connection.id, "L"));
      await store.markReauthRequired(dead.connection.id, "L", at(3));
      const unused = await store.upsertGrant(
        upsert({ userId: "d", now: at(0) }),
      );
      await store.deleteGrant(unused.id);
      await store.upsertGrant(upsert({ userId: "fresh", now: at(100) }));

      const idle = await store.listIdleConnections({
        refreshedBefore: at(50),
        limit: 10,
      });
      expect(idle.map((c) => c.userId)).toEqual(["b", "a"]);
      expect(
        await store.listIdleConnections({ refreshedBefore: at(50), limit: 1 }),
      ).toHaveLength(1);
    });
  });
}
