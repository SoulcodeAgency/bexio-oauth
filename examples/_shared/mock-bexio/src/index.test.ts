import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import { startMockBexio, type MockBexio } from "./index.ts";

let mock: MockBexio;

const json = async <T>(res: Response | Promise<Response>) =>
  (await (await res).json()) as T;
beforeAll(async () => {
  mock = await startMockBexio();
});
afterAll(() => mock.close());

const tokenUrl = () => `${mock.issuer}/protocol/openid-connect/token`;
const form = (body: Record<string, string>) =>
  fetch(tokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: mock.clientId,
      client_secret: mock.clientSecret,
      ...body,
    }),
  });
const refresh = (refreshToken: string) =>
  form({ grant_type: "refresh_token", refresh_token: refreshToken });

const revoke = (refreshToken: string) =>
  fetch(`${mock.issuer}/protocol/openid-connect/revoke`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: mock.clientId,
      client_secret: mock.clientSecret,
      token: refreshToken,
      token_type_hint: "refresh_token",
    }),
  });

/** A full authorization code flow (PKCE) for `login`, as a client would run it. */
async function authorize(login: { sub?: string; companyId?: string }) {
  const redirectUri = "http://app.test/callback";
  const verifier = randomBytes(32).toString("base64url");
  mock.nextLogin(login);
  const auth = new URL(`${mock.issuer}/protocol/openid-connect/auth`);
  auth.search = new URLSearchParams({
    client_id: mock.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid offline_access",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const redirect = await fetch(auth, { redirect: "manual" });
  const code = new URL(redirect.headers.get("location")!).searchParams.get(
    "code",
  )!;
  return json<{ refresh_token: string }>(
    form({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  );
}

describe("mock-bexio", () => {
  it("serves discovery and keys", async () => {
    const meta = await json<{
      issuer: string;
      code_challenge_methods_supported: string[];
      jwks_uri: string;
    }>(fetch(`${mock.issuer}/.well-known/openid-configuration`));
    expect(meta.issuer).toBe(mock.issuer);
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    const jwks = await json<{ keys: unknown[] }>(fetch(meta.jwks_uri));
    expect(jwks.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256" });
  });

  it("issues Bexio-shaped tokens: profile claims in the ID token, only ids in the access token", async () => {
    const tokens = await mock.issueTokens({ companyId: "cmp-beta" });
    expect(decodeJwt(tokens.id_token!)).toMatchObject({
      company_id: "cmp-beta",
      company_name: "Beta GmbH",
    });
    const access = decodeJwt(tokens.access_token);
    expect(access).toMatchObject({
      company_id: "cmp-beta",
      company_user_id: 7,
      azp: mock.clientId,
    });
    for (const claim of ["company_name", "email", "given_name", "name"])
      expect(access[claim]).toBeUndefined();
  });

  it("rotates refresh tokens and kills the session on reuse", async () => {
    const tokens = await mock.issueTokens();
    const first = await form({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(first.status).toBe(200);
    const rotated = (await json<{ refresh_token: string }>(first))
      .refresh_token;
    expect(rotated).not.toBe(tokens.refresh_token);

    const reuse = await form({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    expect(reuse.status).toBe(400);
    expect((await json<{ error: string }>(reuse)).error).toBe("invalid_grant");
    // Reuse revoked the session, so the rotated token is dead too.
    expect(
      (await form({ grant_type: "refresh_token", refresh_token: rotated }))
        .status,
    ).toBe(400);
  });

  it("a new authorization ends the chain of every refresh token issued to that user before", async () => {
    const ada = "8f1c2a8e-0001-4000-8000-000000000001";
    const grace = "8f1c2a8e-0002-4000-8000-000000000002";
    const first = await authorize({ sub: ada, companyId: "cmp-alpha" });
    const rotated = await json<{ refresh_token: string }>(
      refresh(first.refresh_token),
    );
    const graceTokens = await authorize({ sub: grace });
    const second = await authorize({ sub: ada, companyId: "cmp-alpha" });

    const stale = await refresh(rotated.refresh_token);
    expect(stale.status).toBe(400);
    expect(await stale.json()).toEqual({
      error: "invalid_grant",
      error_description: "Refresh token issued before the user session started",
    });
    // The latest authorization works, and other users keep their chains.
    expect((await refresh(second.refresh_token)).status).toBe(200);
    expect((await refresh(graceTokens.refresh_token)).status).toBe(200);
  });

  it("a new authorization for another company keeps the first company's chain", async () => {
    const alpha = await authorize({ companyId: "cmp-alpha" });
    const beta = await authorize({ companyId: "cmp-beta" });
    expect((await refresh(alpha.refresh_token)).status).toBe(200);
    expect((await refresh(beta.refresh_token)).status).toBe(200);
  });

  it("tokens handed out directly count as a new authorization", async () => {
    const before = await authorize({ companyId: "cmp-beta" });
    const direct = await mock.issueTokens({ companyId: "cmp-beta" });
    expect((await refresh(before.refresh_token)).status).toBe(400);
    expect((await refresh(direct.refresh_token)).status).toBe(200);
  });

  it("revoking a refresh token ends its chain", async () => {
    const tokens = await authorize({ companyId: "cmp-beta" });
    const rotated = await json<{ refresh_token: string }>(
      refresh(tokens.refresh_token),
    );
    const revoke = await fetch(
      `${mock.issuer}/protocol/openid-connect/revoke`,
      {
        method: "POST",
        body: new URLSearchParams({
          client_id: mock.clientId,
          client_secret: mock.clientSecret,
          token: rotated.refresh_token,
          token_type_hint: "refresh_token",
        }),
      },
    );
    expect(revoke.status).toBe(200);
    const after = await refresh(rotated.refresh_token);
    expect(after.status).toBe(400);
    expect(await after.json()).toMatchObject({
      error: "invalid_grant",
      error_description: "Session not active",
    });
  });

  it("revoking a token from an older authorization ends the user's current chain too", async () => {
    const stale = await authorize({ companyId: "cmp-alpha" });
    const current = await authorize({ companyId: "cmp-alpha" });
    await revoke(stale.refresh_token);
    expect((await refresh(current.refresh_token)).status).toBe(400);
  });

  it("rejects bad client credentials", async () => {
    const res = await fetch(tokenUrl(), {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "x",
        client_id: "x",
        client_secret: "y",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("serves /3.0/permissions with the admin flag", async () => {
    const admin = await mock.issueTokens({ companyId: "cmp-alpha" });
    const member = await mock.issueTokens({ companyId: "cmp-beta" });
    const perms = async (token: string) =>
      (
        await json<{ permissions: { admin: { activation: string } } }>(
          fetch(`${mock.apiBaseUrl}/3.0/permissions`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        )
      ).permissions.admin.activation;
    expect(await perms(admin.access_token)).toBe("enabled");
    expect(await perms(member.access_token)).toBe("disabled");
    expect((await fetch(`${mock.apiBaseUrl}/3.0/permissions`)).status).toBe(
      401,
    );
  });
});
