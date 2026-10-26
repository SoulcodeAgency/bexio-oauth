import * as oidc from "openid-client";
import { decodeJwt } from "jose";
import { connectionBinding, mapClaims, type ClaimBag } from "./claims.js";
import type { ClientContext } from "./config.js";
import type { TokenCipher } from "./crypto.js";
import { BexioOAuthError } from "./errors.js";
import { fetchRole } from "./permissions.js";
import type {
  ConnectionRecord,
  GrantRecord,
  GrantStore,
} from "./store/types.js";
import type { AccessToken, Grant, GrantSelector } from "./types.js";

/**
 * The app-facing view of a stored grant, with `c` (default: the grant's own)
 * as its connection: no token material.
 */
export function toGrant(
  grant: GrantRecord,
  c: ConnectionRecord = grant.connection,
): Grant {
  return {
    id: grant.id,
    ownerId: grant.ownerId,
    connectionId: c.id,
    companyId: c.companyId,
    companyName: c.companyName,
    userId: c.userId,
    userName: c.userName,
    userEmail: c.userEmail,
    companyUserId: c.companyUserId,
    role: c.role,
    status: c.status,
    scope: c.scope,
    accessExpiresAt: c.accessExpiresAt,
    lastRefreshedAt: c.lastRefreshedAt,
    createdAt: grant.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** The binding a connection's ciphertexts are encrypted under. */
export function bindingOf(connection: ConnectionRecord): string {
  return connectionBinding(connection.companyId, connection.userId);
}

export function decryptFor(
  cipher: TokenCipher,
  connection: ConnectionRecord,
  value: string,
): Promise<string> {
  return cipher.decrypt(value, bindingOf(connection));
}

/** Decrypts the connection's access token for the owner of `grant`. */
export async function issue(
  cipher: TokenCipher,
  grant: GrantRecord,
  connection: ConnectionRecord,
): Promise<AccessToken> {
  return {
    accessToken: await decryptFor(cipher, connection, connection.accessToken),
    expiresAt: connection.accessExpiresAt,
    grant: toGrant(grant, connection),
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

/** Claims a connection needs beyond the ids (see `mapClaims`). */
const PROFILE_CLAIMS = ["company_id", "company_name", "email"];

/**
 * Adds userinfo claims when the tokens lack the profile claims. Bexio's access
 * token carries `company_id` but no company name, email or person name; the
 * ID token has them, so the extra call only happens without one (`saveGrant`
 * with an access token alone). Token claims win over userinfo; a userinfo
 * failure keeps the token claims.
 */
export async function withUserInfo(
  ctx: ClientContext,
  claims: ClaimBag,
  accessToken: string,
): Promise<ClaimBag> {
  if (PROFILE_CLAIMS.every((claim) => claims[claim] !== undefined))
    return claims;
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

/**
 * Encrypts the tokens, reads the role, and upserts the connection for the
 * identity in `claims` and the owner's grant on it.
 */
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
  const binding = connectionBinding(identity.companyId, identity.userId);
  const role =
    (await fetchRole(ctx.fetchImpl, ctx.apiBaseUrl, input.accessToken)) ??
    "member";
  const issuedAt = decodeIfJwt(input.accessToken).iat;
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
    authorizedAt:
      typeof issuedAt === "number" ? new Date(issuedAt * 1000) : ctx.clock(),
    now: ctx.clock(),
  });
}

export async function listGrants(
  store: GrantStore,
  query: { ownerId: string },
): Promise<Grant[]> {
  if (!query?.ownerId)
    throw new BexioOAuthError("invalid_config", "ownerId is required");
  return (await store.findGrants({ ownerId: query.ownerId })).map((g) =>
    toGrant(g),
  );
}

export async function disconnect(
  ctx: ClientContext,
  selector: GrantSelector,
): Promise<void> {
  const grant = await resolveGrant(ctx.store, selector);
  // Delete first, revoke after: revoking ends the one refresh token chain
  // all owners of this identity share, so it may only happen once the store
  // has confirmed that no grant (not even a concurrent one) uses it.
  await ctx.store.deleteGrant(grant.id);
  const deleted = await ctx.store.deleteUnusedConnection(grant.connection.id);
  if (!deleted) return;
  const { connection, userHasOtherConnections } = deleted;
  // Revoking may end the user's current chain at Bexio, whichever token it
  // names. A reauth_required connection's token is dead already, and another
  // connection of the same Bexio user (another company) may share the chain:
  // revoking in either case could only log out someone still using it.
  if (
    !connection.refreshToken ||
    connection.status !== "active" ||
    userHasOtherConnections
  )
    return;
  try {
    const c = await ctx.oidc.config();
    if (c.serverMetadata().revocation_endpoint) {
      await oidc.tokenRevocation(
        c,
        await decryptFor(ctx.cipher, connection, connection.refreshToken),
        { token_type_hint: "refresh_token" },
      );
    }
  } catch {
    // Revocation is best effort; the connection is deleted either way.
  }
}
