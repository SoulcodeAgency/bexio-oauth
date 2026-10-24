import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeProtectedHeader } from "jose";
import { startMockBexio, type MockBexio } from "mock-bexio";
import {
  memoryStore,
  generateKey,
  postgresStore,
  TokenCipherForTests,
  type GrantStore,
} from "./internals.js";
import {
  ADA,
  GRACE,
  authorize,
  client,
  connect,
  cookiesFrom,
  freshDatabase,
  hasDatabase,
  keys,
  mockBexio,
  testClock,
} from "./helpers.js";

let mock: MockBexio;
let store: GrantStore;
let db: Awaited<ReturnType<typeof freshDatabase>> = null;

beforeAll(async () => {
  mock = await mockBexio();
  if (hasDatabase) db = await freshDatabase();
});
afterAll(async () => {
  await mock.close();
  await db?.close();
});

const backends: { name: string; make: () => Promise<GrantStore> }[] = [
  { name: "memory", make: async () => memoryStore() },
];
if (hasDatabase) {
  backends.push({
    name: "postgres",
    make: async () => {
      await db!.truncate();
      return postgresStore(db!.pool);
    },
  });
}

describe.each(backends)("$name store", ({ make }) => {
  beforeEach(async () => {
    store = await make();
  });

  describe("start", () => {
    it("redirects to Bexio with PKCE S256, state, nonce and merged scopes, and sets the flow cookie", async () => {
      const bexio = client(mock, store);
      const res = await bexio.start(new Request("http://app.test/connect"), {
        ownerId: "ws-1",
        returnTo: "/settings",
      });
      expect(res.status).toBe(302);
      const url = new URL(res.headers.get("location")!);
      expect(
        url.href.startsWith(`${mock.issuer}/protocol/openid-connect/auth`),
      ).toBe(true);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("code_challenge")).toBeTruthy();
      expect(url.searchParams.get("state")).toBeTruthy();
      expect(url.searchParams.get("nonce")).toBeTruthy();
      expect(url.searchParams.get("redirect_uri")).toBe(
        "http://app.test/api/bexio/callback",
      );
      expect(url.searchParams.get("scope")!.split(" ")).toEqual(
        expect.arrayContaining([
          "openid",
          "offline_access",
          "company_profile",
          "contact_show",
        ]),
      );

      const cookie = res.headers.getSetCookie()[0]!;
      expect(cookie).toMatch(/^bexio_oauth_flow=/);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/api/bexio/callback");
      expect(cookie).toContain("Max-Age=600");
      // The cookie value is encrypted, not readable state.
      const value = cookie.split(";")[0]!.split("=")[1]!;
      expect(decodeProtectedHeader(value)).toMatchObject({
        alg: "dir",
        enc: "A256GCM",
      });
      expect(value).not.toContain(url.searchParams.get("state"));
      const flow = await new TokenCipherForTests(keys).unseal(
        value,
        new Date(),
      );
      expect(flow).toMatchObject({
        s: url.searchParams.get("state"),
        n: url.searchParams.get("nonce"),
        o: "ws-1",
        r: "/settings",
      });
      // The verifier in the cookie is the one behind the URL's PKCE challenge.
      expect(
        createHash("sha256").update(String(flow!.v)).digest("base64url"),
      ).toBe(url.searchParams.get("code_challenge"));
    });

    it("marks the cookie Secure for https redirect URIs", async () => {
      const bexio = client(mock, store, {
        redirectUri: "https://app.example.com/cb",
      });
      const res = await bexio.start(new Request("https://app.example.com/"), {
        ownerId: "ws-1",
      });
      expect(res.headers.getSetCookie()[0]).toContain("Secure");
    });

    it("rejects returnTo values that could redirect off-site", async () => {
      const bexio = client(mock, store);
      for (const returnTo of [
        "https://evil.example",
        "//evil.example",
        "/\\evil.example",
        "/\t/evil.example",
        "/\n/evil.example",
        "/\r/evil.example",
        "/.//evil.example",
        "/x/..//evil.example",
      ]) {
        await expect(
          bexio.start(new Request("http://app.test/"), {
            ownerId: "ws",
            returnTo,
          }),
        ).rejects.toMatchObject({
          code: "invalid_config",
        });
      }
    });
  });

  describe("callback", () => {
    it("saves one grant with encrypted tokens and mapped claims, clears the cookie, redirects to returnTo", async () => {
      const bexio = client(mock, store);
      const { request } = await authorize(bexio, mock, "ws-1", {
        sub: ADA,
        companyId: "cmp-alpha",
      });
      const res = await bexio.callback(request, { ownerId: "ws-1" });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("http://app.test/settings");
      expect(res.headers.getSetCookie()[0]).toMatch(
        /^bexio_oauth_flow=; .*Max-Age=0/,
      );

      const [grant] = await bexio.listGrants({ ownerId: "ws-1" });
      expect(grant).toMatchObject({
        ownerId: "ws-1",
        companyId: "cmp-alpha",
        companyName: "Alpha AG",
        userId: ADA,
        userName: "Ada Lovelace",
        userEmail: "ada@example.com",
        companyUserId: 1,
        role: "admin",
        status: "active",
      });
      const [row] = await store.findGrants({ ownerId: "ws-1" });
      expect(decodeProtectedHeader(row!.accessToken)).toMatchObject({
        alg: "dir",
        kid: "k1",
      });
      expect(decodeProtectedHeader(row!.refreshToken!)).toMatchObject({
        alg: "dir",
        kid: "k1",
      });
    });

    it("handleCallback returns the grant, returnTo and the cookie-clearing header", async () => {
      const bexio = client(mock, store);
      const { request } = await authorize(bexio, mock, "ws-1", { sub: GRACE });
      const result = await bexio.handleCallback(request, { ownerId: "ws-1" });
      expect(result.grant).toMatchObject({ userId: GRACE, role: "member" });
      expect(result.returnTo).toBe("/settings");
      expect(result.headers.getSetCookie()[0]).toContain("Max-Age=0");
    });

    it("state_mismatch: no cookie, or a state that doesn't match", async () => {
      const bexio = client(mock, store);
      const { request } = await authorize(bexio, mock, "ws-1");
      const noCookie = new Request(request.url);
      await expect(
        bexio.handleCallback(noCookie, { ownerId: "ws-1" }),
      ).rejects.toMatchObject({ code: "state_mismatch" });

      const tampered = new URL(request.url);
      tampered.searchParams.set("state", "other");
      await expect(
        bexio.handleCallback(
          new Request(tampered, { headers: request.headers }),
          { ownerId: "ws-1" },
        ),
      ).rejects.toMatchObject({ code: "state_mismatch" });
      expect(await store.findGrants({ ownerId: "ws-1" })).toHaveLength(0);
    });

    it("state_mismatch: the flow cookie has expired", async () => {
      const clock = testClock();
      const bexio = client(mock, store, { clock: clock.now });
      const { request } = await authorize(bexio, mock, "ws-1");
      clock.advance(601_000);
      await expect(
        bexio.handleCallback(request, { ownerId: "ws-1" }),
      ).rejects.toMatchObject({ code: "state_mismatch" });
    });

    it("owner_mismatch: callback for a different owner than start", async () => {
      const bexio = client(mock, store);
      const { request } = await authorize(bexio, mock, "attacker-ws");
      await expect(
        bexio.handleCallback(request, { ownerId: "victim-ws" }),
      ).rejects.toMatchObject({
        code: "owner_mismatch",
      });
      expect(await store.findGrants({ ownerId: "victim-ws" })).toHaveLength(0);
    });

    it("authorizeOwner: the app approves the owner recorded at start", async () => {
      const bexio = client(mock, store);
      const { request } = await authorize(bexio, mock, "workspace:a");
      const seen: string[] = [];
      const { grant } = await bexio.handleCallback(request, {
        authorizeOwner: (ownerId) => {
          seen.push(ownerId);
          return ownerId === "workspace:a";
        },
      });
      expect(seen).toEqual(["workspace:a"]);
      expect(grant.ownerId).toBe("workspace:a");
    });

    it("authorizeOwner: a denied owner is owner_mismatch and saves nothing", async () => {
      const bexio = client(mock, store);
      const { request } = await authorize(bexio, mock, "workspace:attacker");
      await expect(
        bexio.handleCallback(request, { authorizeOwner: async () => false }),
      ).rejects.toMatchObject({ code: "owner_mismatch" });
      const res = await bexio.callback(request, {
        authorizeOwner: () => false,
      });
      expect(res.headers.get("location")).toContain(
        "bexio_error=owner_mismatch",
      );
      expect(
        await store.findGrants({ ownerId: "workspace:attacker" }),
      ).toHaveLength(0);
    });

    it("access_denied: the user cancels at Bexio, and callback redirects with the error code", async () => {
      const bexio = client(mock, store);
      const { request } = await authorize(bexio, mock, "ws-1", {
        error: "access_denied",
      });
      await expect(
        bexio.handleCallback(request, { ownerId: "ws-1" }),
      ).rejects.toMatchObject({ code: "access_denied" });
      const res = await bexio.callback(request, { ownerId: "ws-1" });
      expect(res.headers.get("location")).toBe(
        "http://app.test/settings?bexio_error=access_denied",
      );
    });

    it("invalid_callback: a reused authorization code", async () => {
      const bexio = client(mock, store);
      const { request } = await authorize(bexio, mock, "ws-1");
      await bexio.handleCallback(request, { ownerId: "ws-1" });
      await expect(
        bexio.handleCallback(request, { ownerId: "ws-1" }),
      ).rejects.toMatchObject({
        code: "invalid_callback",
      });
    });

    it("invalid_callback: a code exchanged with another flow's PKCE verifier", async () => {
      const bexio = client(mock, store);
      const first = await authorize(bexio, mock, "ws-1");
      const second = await authorize(bexio, mock, "ws-1");
      // Code from the first flow, cookie (verifier, nonce, state) from the second.
      const url = new URL(first.request.url);
      url.searchParams.set(
        "state",
        new URL(second.request.url).searchParams.get("state")!,
      );
      const mixed = new Request(url, { headers: second.request.headers });
      await expect(
        bexio.handleCallback(mixed, { ownerId: "ws-1" }),
      ).rejects.toMatchObject({
        code: "invalid_callback",
      });
    });

    it("invalid_callback: an ID token with the wrong nonce, an unknown signing key, or the wrong issuer", async () => {
      const bexio = client(mock, store);
      for (const tamperIdToken of ["nonce", "signature", "issuer"] as const) {
        const { request } = await authorize(bexio, mock, "ws-1", {
          tamperIdToken,
        });
        await expect(
          bexio.handleCallback(request, { ownerId: "ws-1" }),
        ).rejects.toMatchObject({
          code: "invalid_callback",
        });
      }
      expect(await store.findGrants({ ownerId: "ws-1" })).toHaveLength(0);
    });

    it("reconnecting the same owner, company and user overwrites the tokens and keeps one row", async () => {
      const bexio = client(mock, store);
      const first = await connect(bexio, mock, "ws-1", {
        sub: ADA,
        companyId: "cmp-alpha",
      });
      const [before] = await store.findGrants({ ownerId: "ws-1" });
      const lock = {
        id: before!.id,
        now: new Date(),
        lockUntil: new Date(Date.now() + 30_000),
        lockToken: "t",
        refreshedBefore: new Date(Date.now() + 1),
      };
      await store.acquireRefreshLock(lock);
      await store.markReauthRequired(before!.id, "t", new Date());
      const second = await connect(bexio, mock, "ws-1", {
        sub: ADA,
        companyId: "cmp-alpha",
      });
      const rows = await store.findGrants({ ownerId: "ws-1" });
      expect(rows).toHaveLength(1);
      expect(second.grant.id).toBe(first.grant.id);
      expect(rows[0]!.status).toBe("active");
      expect(rows[0]!.accessToken).not.toBe(before!.accessToken);
    });

    it("two owners can connect the same Bexio user and company, and disconnecting one keeps the other", async () => {
      const bexio = client(mock, store);
      await connect(bexio, mock, "ws-a", { sub: ADA, companyId: "cmp-alpha" });
      await connect(bexio, mock, "ws-b", { sub: ADA, companyId: "cmp-alpha" });
      await bexio.disconnect({ ownerId: "ws-a" });
      expect(await bexio.listGrants({ ownerId: "ws-a" })).toHaveLength(0);
      await expect(
        bexio.getAccessToken({ ownerId: "ws-b" }),
      ).resolves.toMatchObject({ grant: { ownerId: "ws-b" } });
    });
  });

  describe("saveGrant", () => {
    it("verifies and saves tokens obtained by an auth framework (with ID token)", async () => {
      const bexio = client(mock, store);
      const tokens = await mock.issueTokens({
        sub: ADA,
        companyId: "cmp-beta",
      });
      const grant = await bexio.saveGrant({
        ownerId: "user-1",
        tokens: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          idToken: tokens.id_token,
        },
      });
      expect(grant).toMatchObject({
        ownerId: "user-1",
        companyId: "cmp-beta",
        companyName: "Beta GmbH",
        role: "member",
      });
      expect(grant.accessExpiresAt).toBeInstanceOf(Date);
      await expect(
        bexio.getAccessToken({ ownerId: "user-1" }),
      ).resolves.toMatchObject({
        accessToken: tokens.access_token,
      });
    });

    it("falls back to userinfo for company claims when there is no ID token", async () => {
      const bexio = client(mock, store);
      const tokens = await mock.issueTokens({ sub: GRACE }, { idToken: false });
      const userinfo = mock.stats.userinfo;
      const grant = await bexio.saveGrant({
        ownerId: "user-2",
        tokens: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
        },
      });
      expect(mock.stats.userinfo).toBe(userinfo + 1);
      expect(grant).toMatchObject({
        companyId: "cmp-alpha",
        userEmail: "grace@example.com",
      });
    });

    it("rejects an ID token that belongs to another user", async () => {
      const bexio = client(mock, store);
      const ada = await mock.issueTokens({ sub: ADA });
      const grace = await mock.issueTokens({ sub: GRACE });
      await expect(
        bexio.saveGrant({
          ownerId: "u",
          tokens: { accessToken: ada.access_token, idToken: grace.id_token },
        }),
      ).rejects.toMatchObject({ code: "invalid_callback" });
    });

    it("rejects a token from another issuer or with a bad signature", async () => {
      const bexio = client(mock, store);
      const foreignIssuer = await mock.signAccessToken(
        { sub: ADA },
        { issuer: "https://evil.example/realms/x" },
      );
      const foreignKey = await mock.signAccessToken(
        { sub: ADA, company_id: "cmp-alpha" },
        { foreignKey: true },
      );
      for (const accessToken of [foreignIssuer, foreignKey, "not-a-jwt"]) {
        await expect(
          bexio.saveGrant({ ownerId: "u", tokens: { accessToken } }),
        ).rejects.toMatchObject({
          code: "invalid_callback",
        });
      }
      expect(await store.findGrants({ ownerId: "u" })).toHaveLength(0);
    });

    it("rejects an access token without azp, and an ID token passed as access token", async () => {
      const bexio = client(mock, store);
      const noAzp = await mock.signAccessToken({
        sub: ADA,
        company_id: "cmp-alpha",
        azp: undefined,
      });
      const tokens = await mock.issueTokens({ sub: ADA });
      for (const accessToken of [noAzp, tokens.id_token!]) {
        await expect(
          bexio.saveGrant({ ownerId: "u", tokens: { accessToken } }),
        ).rejects.toMatchObject({
          code: "invalid_callback",
        });
      }
    });

    it("reports a broken signing-keys response (503) as idp_error", async () => {
      const fetchImpl: typeof fetch = (input, init) =>
        String(input instanceof Request ? input.url : input).endsWith("/certs")
          ? Promise.resolve(new Response("unavailable", { status: 503 }))
          : fetch(input, init);
      const bexio = client(mock, store, { fetch: fetchImpl });
      const tokens = await mock.issueTokens({ sub: ADA });
      await expect(
        bexio.saveGrant({
          ownerId: "u",
          tokens: { accessToken: tokens.access_token },
        }),
      ).rejects.toMatchObject({ code: "idp_error" });
    });

    it("reports unreachable signing keys as idp_error, not as a bad token", async () => {
      const fetchImpl: typeof fetch = (input, init) =>
        String(input instanceof Request ? input.url : input).endsWith("/certs")
          ? Promise.reject(new TypeError("network down"))
          : fetch(input, init);
      const bexio = client(mock, store, { fetch: fetchImpl });
      const tokens = await mock.issueTokens({ sub: ADA });
      await expect(
        bexio.saveGrant({
          ownerId: "u",
          tokens: { accessToken: tokens.access_token },
        }),
      ).rejects.toMatchObject({ code: "idp_error" });
    });

    it("rejects an access token issued to another client", async () => {
      const bexio = client(mock, store);
      const accessToken = await mock.signAccessToken({
        sub: ADA,
        company_id: "cmp-alpha",
        azp: "other-app",
      });
      await expect(
        bexio.saveGrant({ ownerId: "u", tokens: { accessToken } }),
      ).rejects.toMatchObject({
        code: "invalid_callback",
      });
    });
  });

  describe("getAccessToken", () => {
    it("returns the stored token while it is valid, without calling Bexio", async () => {
      const bexio = client(mock, store);
      await connect(bexio, mock, "ws-1");
      const before = { ...mock.stats };
      const { accessToken, grant } = await bexio.getAccessToken({
        ownerId: "ws-1",
      });
      expect(accessToken.split(".")).toHaveLength(3);
      expect(grant.ownerId).toBe("ws-1");
      expect(mock.stats).toEqual(before);
    });

    it("refreshes an expired token and stores the rotated refresh token", async () => {
      const clock = testClock();
      const bexio = client(mock, store, { clock: clock.now });
      await connect(bexio, mock, "ws-1");
      const [before] = await store.findGrants({ ownerId: "ws-1" });
      const first = await bexio.getAccessToken({ ownerId: "ws-1" });
      clock.advance(10 * 60_000);
      const refreshes = mock.stats.refreshTokenGrants;
      const second = await bexio.getAccessToken({ ownerId: "ws-1" });
      expect(mock.stats.refreshTokenGrants).toBe(refreshes + 1);
      expect(second.accessToken).not.toBe(first.accessToken);
      const [after] = await store.findGrants({ ownerId: "ws-1" });
      expect(after!.refreshToken).not.toBe(before!.refreshToken);
      expect(after!.lastRefreshedAt.getTime()).toBe(clock.now().getTime());
      // The rotated token works again on the next expiry.
      clock.advance(10 * 60_000);
      await expect(
        bexio.getAccessToken({ ownerId: "ws-1" }),
      ).resolves.toBeTruthy();
    });

    it("marks the grant reauth_required when Bexio rejects the refresh token, then stops calling Bexio", async () => {
      const clock = testClock();
      const bexio = client(mock, store, { clock: clock.now });
      await connect(bexio, mock, "ws-1", { sub: GRACE });
      mock.revokeSessions(GRACE);
      clock.advance(10 * 60_000);
      await expect(
        bexio.getAccessToken({ ownerId: "ws-1" }),
      ).rejects.toMatchObject({ code: "reauth_required" });
      expect((await bexio.listGrants({ ownerId: "ws-1" }))[0]!.status).toBe(
        "reauth_required",
      );
      const calls = mock.stats.rejectedRefreshes;
      await expect(
        bexio.getAccessToken({ ownerId: "ws-1" }),
      ).rejects.toMatchObject({ code: "reauth_required" });
      expect(mock.stats.rejectedRefreshes).toBe(calls);
    });

    it("not_connected and ambiguous_grant", async () => {
      const bexio = client(mock, store);
      await expect(
        bexio.getAccessToken({ ownerId: "nobody" }),
      ).rejects.toMatchObject({ code: "not_connected" });
      await connect(bexio, mock, "ws-1", { sub: ADA, companyId: "cmp-alpha" });
      await connect(bexio, mock, "ws-1", { sub: ADA, companyId: "cmp-beta" });
      await expect(
        bexio.getAccessToken({ ownerId: "ws-1" }),
      ).rejects.toMatchObject({ code: "ambiguous_grant" });
      await expect(
        bexio.getAccessToken({ ownerId: "ws-1", companyId: "cmp-beta" }),
      ).resolves.toMatchObject({
        grant: { companyId: "cmp-beta", role: "member" },
      });
      const [grant] = await bexio.listGrants({ ownerId: "ws-1" });
      await expect(
        bexio.getAccessToken({ ownerId: "ws-1", grantId: grant!.id }),
      ).resolves.toBeTruthy();
      await expect(
        bexio.getAccessToken({ ownerId: "ws-1", grantId: "not-a-uuid" }),
      ).rejects.toMatchObject({
        code: "not_connected",
      });
    });

    it("updates the role on refresh, and keeps it when the permissions call fails", async () => {
      const clock = testClock();
      let failPermissions = false;
      const fetchImpl: typeof fetch = (input, init) => {
        if (
          failPermissions &&
          String(input instanceof Request ? input.url : input).includes(
            "/3.0/permissions",
          )
        ) {
          return Promise.resolve(new Response("down", { status: 503 }));
        }
        return fetch(input, init);
      };
      const bexio = client(mock, store, { clock: clock.now, fetch: fetchImpl });
      await connect(bexio, mock, "ws-1", { sub: GRACE });
      expect((await bexio.listGrants({ ownerId: "ws-1" }))[0]!.role).toBe(
        "member",
      );

      mock.setAdmin(GRACE, "cmp-alpha", true);
      clock.advance(10 * 60_000);
      await bexio.getAccessToken({ ownerId: "ws-1" });
      expect((await bexio.listGrants({ ownerId: "ws-1" }))[0]!.role).toBe(
        "admin",
      );

      failPermissions = true;
      mock.setAdmin(GRACE, "cmp-alpha", false);
      clock.advance(10 * 60_000);
      await bexio.getAccessToken({ ownerId: "ws-1" });
      expect((await bexio.listGrants({ ownerId: "ws-1" }))[0]!.role).toBe(
        "admin",
      );
      mock.setAdmin(GRACE, "cmp-alpha", false);
    });
  });

  describe("configuration", () => {
    it("refuses a refresh lock TTL shorter than one refresh can take", () => {
      expect(() => client(mock, store, { refreshLockTtl: "5s" })).toThrow(
        /at least 30s/,
      );
    });
  });

  describe("lost refresh lock", () => {
    it("a reconnect during a refresh wins, and the caller gets the reconnected token", async () => {
      const clock = testClock();
      let reconnected: string | undefined;
      const base = client(mock, store, { clock: clock.now });
      // Delay the refresh call and reconnect the same grant while it is in flight.
      const fetchImpl: typeof fetch = async (input, init) => {
        const isRefresh =
          String(input instanceof Request ? input.url : input).endsWith(
            "/token",
          ) && String(init?.body ?? "").includes("grant_type=refresh_token");
        if (isRefresh && !reconnected) {
          await connect(base, mock, "ws-1", {
            sub: ADA,
            companyId: "cmp-alpha",
          });
          reconnected = (await store.findGrants({ ownerId: "ws-1" }))[0]!
            .accessToken;
        }
        return fetch(input, init);
      };
      await connect(base, mock, "ws-1", { sub: ADA, companyId: "cmp-alpha" });
      clock.advance(10 * 60_000);
      const racing = client(mock, store, {
        clock: clock.now,
        fetch: fetchImpl,
      });
      const result = await racing.getAccessToken({ ownerId: "ws-1" });

      const [row] = await store.findGrants({ ownerId: "ws-1" });
      // The fenced save changed nothing: the reconnect's tokens are still there.
      expect(row!.accessToken).toBe(reconnected);
      expect(row!.status).toBe("active");
      expect(result.accessToken).toBe(
        (await base.getAccessToken({ ownerId: "ws-1" })).accessToken,
      );
    });
  });

  describe("decryption", () => {
    it("a missing key fails with decryption_failed but leaves the grant intact", async () => {
      const clock = testClock();
      await connect(client(mock, store, { clock: clock.now }), mock, "ws-1");
      clock.advance(10 * 60_000);
      const other = client(mock, store, {
        clock: clock.now,
        keys: { current: "k2", keys: { k2: generateKey() } },
      });
      await expect(
        other.getAccessToken({ ownerId: "ws-1" }),
      ).rejects.toMatchObject({ code: "decryption_failed" });
      const [grant] = await other.listGrants({ ownerId: "ws-1" });
      expect(grant!.status).toBe("active");
      // Restoring the key fixes it: the lock was released, nothing was burned.
      await expect(
        client(mock, store, { clock: clock.now }).getAccessToken({
          ownerId: "ws-1",
        }),
      ).resolves.toBeTruthy();
    });
  });

  describe("disconnect", () => {
    it("deletes the grant when the issuer has no revocation endpoint", async () => {
      const noRevoke = await startMockBexio({
        clientId: "test-client",
        clientSecret: "test-secret",
        revocationEndpoint: false,
      });
      try {
        const bexio = client(noRevoke, store);
        await connect(bexio, noRevoke, "ws-1");
        await bexio.disconnect({ ownerId: "ws-1" });
        expect(noRevoke.stats.revocations).toBe(0);
        expect(await bexio.listGrants({ ownerId: "ws-1" })).toHaveLength(0);
      } finally {
        await noRevoke.close();
      }
    });

    it("revokes the refresh token at Bexio and deletes the grant", async () => {
      const bexio = client(mock, store);
      await connect(bexio, mock, "ws-1");
      const revocations = mock.stats.revocations;
      await bexio.disconnect({ ownerId: "ws-1" });
      expect(mock.stats.revocations).toBe(revocations + 1);
      expect(await bexio.listGrants({ ownerId: "ws-1" })).toHaveLength(0);
    });

    it("still deletes the grant when revocation fails", async () => {
      const fetchImpl: typeof fetch = (input, init) =>
        String(input instanceof Request ? input.url : input).includes("/revoke")
          ? Promise.reject(new TypeError("network down"))
          : fetch(input, init);
      const bexio = client(mock, store, { fetch: fetchImpl });
      await connect(bexio, mock, "ws-1");
      await bexio.disconnect({ ownerId: "ws-1" });
      expect(await bexio.listGrants({ ownerId: "ws-1" })).toHaveLength(0);
    });
  });

  describe("refreshIdle", () => {
    it("reports idle grants as failed instead of throwing when Bexio is unreachable", async () => {
      const clock = testClock();
      await connect(client(mock, store, { clock: clock.now }), mock, "idle");
      clock.advance(8 * 86_400_000);
      // A fresh client (no cached discovery) whose requests to Bexio all fail.
      const offline = client(mock, store, {
        clock: clock.now,
        fetch: () => Promise.reject(new TypeError("network down")),
      });
      expect(await offline.refreshIdle({ idleFor: "7d" })).toEqual({
        refreshed: 0,
        skipped: 0,
        reauthRequired: 0,
        failed: 1,
      });
    });

    it("skips idle grants another process is refreshing", async () => {
      const clock = testClock();
      const bexio = client(mock, store, { clock: clock.now });
      const { grant } = await connect(bexio, mock, "busy");
      clock.advance(8 * 86_400_000);
      await store.acquireRefreshLock({
        id: grant.id,
        now: clock.now(),
        lockUntil: new Date(clock.now().getTime() + 30_000),
        lockToken: "someone-else",
        refreshedBefore: clock.now(),
      });
      expect(await bexio.refreshIdle({ idleFor: "7d" })).toEqual({
        refreshed: 0,
        skipped: 1,
        reauthRequired: 0,
        failed: 0,
      });
    });

    it("refreshes idle grants, skips fresh ones, and marks dead ones", async () => {
      const clock = testClock();
      const bexio = client(mock, store, { clock: clock.now });
      await connect(bexio, mock, "idle", { sub: ADA, companyId: "cmp-alpha" });
      await connect(bexio, mock, "dead", { sub: GRACE });
      clock.advance(8 * 86_400_000);
      await connect(bexio, mock, "fresh", { sub: ADA, companyId: "cmp-beta" });
      mock.revokeSessions(GRACE);

      const result = await bexio.refreshIdle({ idleFor: "7d" });
      expect(result).toEqual({
        refreshed: 1,
        skipped: 0,
        reauthRequired: 1,
        failed: 0,
      });
      expect(
        (await bexio.listGrants({ ownerId: "idle" }))[0]!.lastRefreshedAt,
      ).toEqual(clock.now());
      expect((await bexio.listGrants({ ownerId: "dead" }))[0]!.status).toBe(
        "reauth_required",
      );
      expect(await bexio.refreshIdle({ idleFor: "7d" })).toEqual({
        refreshed: 0,
        skipped: 0,
        reauthRequired: 0,
        failed: 0,
      });
    });
  });

  describe("secrets never leak", () => {
    it("keeps token values out of errors and listGrants", async () => {
      const clock = testClock();
      const bexio = client(mock, store, { clock: clock.now });
      const { request } = await authorize(bexio, mock, "ws-1", {
        sub: ADA,
        companyId: "cmp-alpha",
      });
      const { grant } = await bexio.handleCallback(request, {
        ownerId: "ws-1",
      });
      const { accessToken } = await bexio.getAccessToken({ ownerId: "ws-1" });
      const [row] = await store.findGrants({ ownerId: "ws-1" });
      const storedRefresh = row!.refreshToken!;

      const listed = JSON.stringify(
        await bexio.listGrants({ ownerId: "ws-1" }),
      );
      expect(listed).not.toContain(accessToken);
      expect(Object.keys(grant)).not.toEqual(
        expect.arrayContaining(["accessToken", "refreshToken"]),
      );
      expect(listed).not.toContain(storedRefresh);

      mock.revokeSessions(ADA);
      clock.advance(10 * 60_000);
      const error = (await bexio.getAccessToken({ ownerId: "ws-1" }).then(
        () => null,
        (e: unknown) => e,
      )) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(
        JSON.stringify({ message: error.message, stack: error.stack }),
      ).not.toContain(accessToken);
    });
  });
});

it("cookiesFrom helper reads Set-Cookie pairs", () => {
  const res = new Response(null, {
    headers: [
      ["Set-Cookie", "a=1; Path=/"],
      ["Set-Cookie", "b=2"],
    ],
  });
  expect(cookiesFrom(res)).toBe("a=1; b=2");
});
