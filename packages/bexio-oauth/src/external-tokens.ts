import { errors as joseErrors, jwtVerify } from "jose";
import type { ClaimBag } from "./claims.js";
import type { ClientContext } from "./config.js";
import { BexioOAuthError } from "./errors.js";
import { saveTokens, toGrant, withUserInfo } from "./grants.js";
import { describe } from "./oidc.js";
import type { ExternalTokens, Grant } from "./types.js";

const SIGNING_ALGORITHMS = ["RS256", "PS256", "ES256"];

/**
 * Verifies a token's signature against Bexio's keys, plus issuer, expiry and
 * (when given) audience. Not getting the keys is `idp_error`; a token that
 * fails a check is `invalid_callback`.
 */
async function verifyBexioJwt(
  ctx: ClientContext,
  token: string,
  issuer: string,
  audience?: string,
): Promise<ClaimBag> {
  const keys = await ctx.oidc.keySet();
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience,
      algorithms: SIGNING_ALGORITHMS,
      currentDate: ctx.clock(),
    });
    return payload;
  } catch (error) {
    // Not getting Bexio's keys is an outage, not a bad token.
    // (jose reports a bad JWKS response, e.g. a 503, as its generic error.)
    if (
      error instanceof joseErrors.JWKSTimeout ||
      error instanceof TypeError ||
      (error instanceof joseErrors.JOSEError &&
        error.code === "ERR_JOSE_GENERIC")
    ) {
      throw new BexioOAuthError(
        "idp_error",
        "could not load Bexio's signing keys",
        { cause: describe(error) },
      );
    }
    throw new BexioOAuthError(
      "invalid_callback",
      "token signature, issuer or expiry check failed",
      { cause: describe(error) },
    );
  }
}

/** `BexioOAuth.saveGrant`: verifies tokens from your auth framework, then stores them. */
export async function saveGrant(
  ctx: ClientContext,
  input: { ownerId: string; tokens: ExternalTokens },
): Promise<Grant> {
  if (!input?.ownerId)
    throw new BexioOAuthError("invalid_config", "ownerId is required");
  const { tokens } = input;
  if (!tokens?.accessToken)
    throw new BexioOAuthError(
      "invalid_config",
      "tokens.accessToken is required",
    );
  const issuer = (await ctx.oidc.config()).serverMetadata().issuer;
  const accessClaims = await verifyBexioJwt(ctx, tokens.accessToken, issuer);
  // Must be an access token issued to this app: rejects tokens issued to
  // another client (token substitution) and ID tokens passed as access tokens.
  if (accessClaims.azp !== ctx.clientId) {
    throw new BexioOAuthError(
      "invalid_callback",
      "access token was not issued to this client",
    );
  }
  if (accessClaims.typ !== undefined && accessClaims.typ !== "Bearer") {
    throw new BexioOAuthError(
      "invalid_callback",
      "tokens.accessToken is not an access token",
    );
  }
  const idClaims = tokens.idToken
    ? await verifyBexioJwt(ctx, tokens.idToken, issuer, ctx.clientId)
    : {};
  if (tokens.idToken && idClaims.sub !== accessClaims.sub) {
    throw new BexioOAuthError(
      "invalid_callback",
      "ID token and access token belong to different users",
    );
  }
  const claims = await withUserInfo(
    ctx,
    { ...accessClaims, ...idClaims },
    tokens.accessToken,
  );
  const exp =
    typeof accessClaims.exp === "number"
      ? new Date(accessClaims.exp * 1000)
      : null;
  const record = await saveTokens(ctx, {
    ownerId: input.ownerId,
    claims,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken ?? null,
    accessExpiresAt: tokens.expiresAt ?? exp,
    refreshExpiresAt: null,
    scope:
      tokens.scope ??
      (typeof accessClaims.scope === "string" ? accessClaims.scope : null),
  });
  return toGrant(record);
}
