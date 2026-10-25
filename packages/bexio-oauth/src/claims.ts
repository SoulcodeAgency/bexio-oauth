import { BexioOAuthError } from "./errors.js";

/** Bexio's production OIDC issuer (Keycloak realm). */
export const BEXIO_ISSUER = "https://auth.bexio.com/realms/bexio";
/** Bexio's production API base URL. */
export const BEXIO_API_BASE_URL = "https://api.bexio.com";
/**
 * Always requested. `company_profile` adds the company claims; `offline_access`
 * issues a refresh token that keeps working without the user present.
 */
export const BASE_SCOPES: readonly string[] = Object.freeze([
  "openid",
  "profile",
  "email",
  "company_profile",
  "offline_access",
]);

export type ClaimBag = Record<string, unknown>;

/** Who granted access, as read from Bexio's ID token, access token and userinfo. */
export interface BexioIdentity {
  /** OIDC `sub`. */
  userId: string;
  /** `company_id` (company_profile scope). */
  companyId: string;
  companyName: string | null;
  /** `company_user_id` (access token): the user's id inside the company. */
  companyUserId: number | null;
  userName: string | null;
  userEmail: string | null;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return typeof parsed === "number" && Number.isInteger(parsed) ? parsed : null;
}

/**
 * Maps a merged claim bag (ID token + access token + userinfo) to a
 * `BexioIdentity`. Throws `invalid_callback` when `sub` or `company_id` is
 * missing.
 */
export function mapClaims(claims: ClaimBag): BexioIdentity {
  const userId = text(claims.sub);
  if (!userId)
    throw new BexioOAuthError("invalid_callback", "missing sub claim");
  const companyId = text(claims.company_id);
  if (!companyId) {
    throw new BexioOAuthError(
      "invalid_callback",
      "missing company_id claim (is the company_profile scope requested?)",
    );
  }
  const given = text(claims.given_name);
  const family = text(claims.family_name);
  return {
    userId,
    companyId,
    companyName: text(claims.company_name),
    companyUserId: integer(claims.company_user_id),
    userName:
      given && family
        ? `${given} ${family}`
        : (text(claims.name) ?? given ?? family),
    userEmail: text(claims.email),
  };
}

/** The value a grant's ciphertext is bound to (see `TokenCipher`). */
export function grantBinding(
  ownerId: string,
  companyId: string,
  userId: string,
): string {
  return `${ownerId}\u0000${companyId}\u0000${userId}`;
}
