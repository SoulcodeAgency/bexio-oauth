import * as oidc from "openid-client";
import { decodeJwt } from "jose";
import { grantBinding, mapClaims, type ClaimBag } from "./claims.js";
import type { ClientContext } from "./config.js";
import type { TokenCipher } from "./crypto.js";
import { BexioOAuthError } from "./errors.js";
import { fetchRole } from "./permissions.js";
import type { GrantRecord, GrantStore } from "./store/types.js";
import type { AccessToken, Grant, GrantSelector } from "./types.js";

/** The app-facing view of a stored grant: no token material. */
export function toGrant(r: GrantRecord): Grant {
  return {
    id: r.id,
    ownerId: r.ownerId,
    companyId: r.companyId,
    companyName: r.companyName,
    userId: r.userId,
    userName: r.userName,
    userEmail: r.userEmail,
    companyUserId: r.companyUserId,
    role: r.role,
    status: r.status,
    scope: r.scope,
    accessExpiresAt: r.accessExpiresAt,
    lastRefreshedAt: r.lastRefreshedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** The binding a grant's ciphertexts are encrypted under. */
export function bindingOf(record: GrantRecord): string {
  return grantBinding(record.ownerId, record.companyId, record.userId);
}

export function decryptFor(
  cipher: TokenCipher,
  record: GrantRecord,
  value: string,
): Promise<string> {
  return cipher.decrypt(value, bindingOf(record));
}

/** Decrypts the grant's access token for the caller. */
export async function issue(
  cipher: TokenCipher,
  record: GrantRecord,
): Promise<AccessToken> {
  return {
    accessToken: await decryptFor(cipher, record, record.accessToken),
    expiresAt: record.accessExpiresAt,
    grant: toGrant(record),
  };
}

/** Exactly one grant of the owner, or `not_connected` / `ambiguous_grant`. */
export async function resolveGrant(
  store: GrantStore,
  selector: GrantSelector,
): Promise<GrantRecord> {
  if (!selector?.ownerId)
    throw new BexioOAuthError("invalid_config", "ownerId is required");
  const rows = await store.findGrants(selector);
  if (rows.length === 0)
    throw new BexioOAuthError("not_connected", "owner has no matching grant");
  if (rows.length > 1) {
    throw new BexioOAuthError(
      "ambiguous_grant",
      "owner has several grants; pass companyId or grantId",
    );
  }
  return rows[0]!;
}

/** The token's claims if it is a JWT, else none (Bexio access tokens usually are). */
export function decodeIfJwt(token: string): ClaimBag {
  try {
    return decodeJwt(token);
  } catch {
    return {};
  }
}

/**
 * Adds userinfo claims, only when the tokens lack the company claims. Token
 * claims win over userinfo; a userinfo failure keeps the token claims.
 */
export async function withUserInfo(
  ctx: ClientContext,
  claims: ClaimBag,
  accessToken: string,
): Promise<ClaimBag> {
  if (claims.company_id !== undefined) return claims;
  try {
    const info = await oidc.fetchUserInfo(
      await ctx.oidc.config(),
      accessToken,
      typeof claims.sub === "string" ? claims.sub : oidc.skipSubjectCheck,
    );
    return { ...info, ...claims };
  } catch {
    return claims;
  }
}

/** Encrypts the tokens, reads the role and upserts the grant for the identity in `claims`. */
export async function saveTokens(
  ctx: ClientContext,
  input: {
    ownerId: string;
    claims: ClaimBag;
    accessToken: string;
    refreshToken: string | null;
    accessExpiresAt: Date | null;
    refreshExpiresAt: Date | null;
    scope: string | null;
  },
): Promise<GrantRecord> {
  const identity = mapClaims(input.claims);
  const binding = grantBinding(
    input.ownerId,
    identity.companyId,
    identity.userId,
  );
  const role =
    (await fetchRole(ctx.fetchImpl, ctx.apiBaseUrl, input.accessToken)) ??
    "member";
  return ctx.store.upsertGrant({
    ownerId: input.ownerId,
    ...identity,
    role,
    accessToken: await ctx.cipher.encrypt(input.accessToken, binding),
    refreshToken: input.refreshToken
      ? await ctx.cipher.encrypt(input.refreshToken, binding)
      : null,
    accessExpiresAt: input.accessExpiresAt,
    refreshExpiresAt: input.refreshExpiresAt,
    scope: input.scope,
    now: ctx.clock(),
  });
}

export async function listGrants(
  store: GrantStore,
  query: { ownerId: string },
): Promise<Grant[]> {
  if (!query?.ownerId)
    throw new BexioOAuthError("invalid_config", "ownerId is required");
  return (await store.findGrants({ ownerId: query.ownerId })).map(toGrant);
}

export async function disconnect(
  ctx: ClientContext,
  selector: GrantSelector,
): Promise<void> {
  const record = await resolveGrant(ctx.store, selector);
  try {
    const c = await ctx.oidc.config();
    if (record.refreshToken && c.serverMetadata().revocation_endpoint) {
      await oidc.tokenRevocation(
        c,
        await decryptFor(ctx.cipher, record, record.refreshToken),
        { token_type_hint: "refresh_token" },
      );
    }
  } catch {
    // Revocation is best effort; the grant is deleted either way.
  }
  await ctx.store.deleteGrant(record.id);
}
