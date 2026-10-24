import { beforeEach, describe, expect, it } from "vitest";
import type { GrantRefresh, GrantStore, GrantUpsert } from "../src/index.js";

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

const refresh = (overrides: Partial<GrantRefresh> = {}): GrantRefresh => ({
  accessToken: "enc-access-2",
  refreshToken: null,
  accessExpiresAt: at(700_000),
  refreshExpiresAt: null,
  scope: null,
  role: null,
  now: at(400_000),
  ...overrides,
});

/** A lock request for a grant whose access token has expired at `at(400_000)`. */
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

    it("upsert inserts, then overwrites the same (owner, company, user)", async () => {
      const a = await store.upsertGrant(upsert());
      expect(a).toMatchObject({
        ownerId: "owner-1",
        status: "active",
        lastRefreshedAt: t0,
        createdAt: t0,
      });
      await store.acquireRefreshLock(expired(a.id, "L1"));
      await store.markReauthRequired(a.id, "L1", at(1));
      const b = await store.upsertGrant(
        upsert({ accessToken: "enc-access-2", role: "admin", now: at(5_000) }),
      );
      expect(b.id).toBe(a.id);
      expect(b).toMatchObject({
        accessToken: "enc-access-2",
        role: "admin",
        status: "active",
        createdAt: t0,
      });
      expect(await store.findGrants({ ownerId: "owner-1" })).toHaveLength(1);
    });

    it("finds by owner, company and grant id", async () => {
      const a = await store.upsertGrant(upsert());
      await store.upsertGrant(upsert({ companyId: "cmp-2", now: at(1) }));
      await store.upsertGrant(upsert({ ownerId: "owner-2" }));
      expect(await store.findGrants({ ownerId: "owner-1" })).toHaveLength(2);
      expect(
        await store.findGrants({ ownerId: "owner-1", companyId: "cmp-2" }),
      ).toHaveLength(1);
      expect(
        await store.findGrants({ ownerId: "owner-1", grantId: a.id }),
      ).toEqual([a]);
      expect(await store.getGrant(a.id)).toEqual(a);
    });

    it("refresh lock: one winner, honors the condition, expires", async () => {
      const g = await store.upsertGrant(
        upsert({ accessExpiresAt: at(10_000) }),
      );
      // Not expiring yet → nothing to do.
      expect(
        await store.acquireRefreshLock({
          id: g.id,
          now: t0,
          lockUntil: at(30_000),
          lockToken: "L0",
          accessExpiresBefore: at(5_000),
        }),
      ).toBeNull();
      expect(
        await store.acquireRefreshLock(expired(g.id, "L1", 20_000)),
      ).toMatchObject({
        id: g.id,
        refreshLockedUntil: at(50_000),
      });
      expect(
        await store.acquireRefreshLock(expired(g.id, "L2", 20_000)),
      ).toBeNull();
      // After the lock expires, the next caller takes over.
      expect(
        await store.acquireRefreshLock(expired(g.id, "L3", 50_000)),
      ).toMatchObject({
        refreshLockedUntil: at(80_000),
      });
    });

    it("refresh lock by idle time", async () => {
      const g = await store.upsertGrant(upsert());
      const req = { id: g.id, now: at(1), lockUntil: at(2), lockToken: "L" };
      expect(
        await store.acquireRefreshLock({ ...req, refreshedBefore: t0 }),
      ).toBeNull();
      expect(
        await store.acquireRefreshLock({ ...req, refreshedBefore: at(1) }),
      ).not.toBeNull();
    });

    it("saveRefreshed stores tokens, keeps nulls, releases the lock", async () => {
      const g = await store.upsertGrant(upsert());
      await store.acquireRefreshLock(expired(g.id, "L1"));
      const saved = await store.saveRefreshed(g.id, "L1", refresh());
      expect(saved).toMatchObject({
        accessToken: "enc-access-2",
        refreshToken: "enc-refresh",
        scope: "openid",
        role: "member",
        refreshLockedUntil: null,
        lastRefreshedAt: at(400_000),
      });
    });

    it("fences holder writes: an expired or replaced lock changes nothing", async () => {
      const g = await store.upsertGrant(upsert());
      await store.acquireRefreshLock(expired(g.id, "stale", 400_000, 1_000));
      // The stale holder's lock expires and a second caller takes over.
      await store.acquireRefreshLock(expired(g.id, "fresh", 402_000));
      expect(
        await store.saveRefreshed(g.id, "stale", refresh({ accessToken: "x" })),
      ).toBeNull();
      await store.markReauthRequired(g.id, "stale", at(402_500));
      await store.releaseRefreshLock(g.id, "stale");
      const row = await store.getGrant(g.id);
      expect(row).toMatchObject({
        accessToken: "enc-access",
        status: "active",
        refreshLockedUntil: at(432_000),
      });
      // The current holder still can.
      expect(await store.saveRefreshed(g.id, "fresh", refresh())).toMatchObject(
        { accessToken: "enc-access-2" },
      );
    });

    it("a reconnect clears the lock, so the in-flight refresh can't clobber it", async () => {
      const g = await store.upsertGrant(upsert());
      await store.acquireRefreshLock(expired(g.id, "L1"));
      await store.upsertGrant(
        upsert({ accessToken: "enc-reconnected", now: at(401_000) }),
      );
      expect(await store.saveRefreshed(g.id, "L1", refresh())).toBeNull();
      await store.markReauthRequired(g.id, "L1", at(402_000));
      expect(await store.getGrant(g.id)).toMatchObject({
        accessToken: "enc-reconnected",
        status: "active",
        refreshLockedUntil: null,
      });
    });

    it("markReauthRequired and releaseRefreshLock with the right token, then delete", async () => {
      const g = await store.upsertGrant(upsert());
      await store.acquireRefreshLock(expired(g.id, "L1"));
      await store.releaseRefreshLock(g.id, "L1");
      expect((await store.getGrant(g.id))!.refreshLockedUntil).toBeNull();
      await store.acquireRefreshLock(expired(g.id, "L2"));
      await store.markReauthRequired(g.id, "L2", at(1));
      expect((await store.getGrant(g.id))!.status).toBe("reauth_required");
      // A reauth_required grant can't be locked for refresh.
      expect(await store.acquireRefreshLock(expired(g.id, "L3"))).toBeNull();
      await store.deleteGrant(g.id);
      expect(await store.getGrant(g.id)).toBeNull();
    });

    it("lists active idle grants, oldest first, with a limit", async () => {
      await store.upsertGrant(upsert({ ownerId: "a", now: at(2) }));
      await store.upsertGrant(upsert({ ownerId: "b", now: at(1) }));
      const dead = await store.upsertGrant(
        upsert({ ownerId: "c", now: at(0) }),
      );
      await store.acquireRefreshLock(expired(dead.id, "L"));
      await store.markReauthRequired(dead.id, "L", at(3));
      await store.upsertGrant(upsert({ ownerId: "fresh", now: at(100) }));
      const idle = await store.listIdleGrants({
        refreshedBefore: at(50),
        limit: 10,
      });
      expect(idle.map((g) => g.ownerId)).toEqual(["b", "a"]);
      expect(
        await store.listIdleGrants({ refreshedBefore: at(50), limit: 1 }),
      ).toHaveLength(1);
    });
  });
}
