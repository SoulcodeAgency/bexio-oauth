/**
 * Every failure the library reports is a `BexioOAuthError` with a stable
 * `code`. Messages never contain token values; `cause`, when set, is a safe
 * summary of the upstream error (name, OAuth error code, HTTP status).
 */
export type BexioOAuthErrorCode =
  /** Flow cookie missing, expired, or `state` does not match. */
  | "state_mismatch"
  /** The `ownerId` at callback differs from the one passed to `start`. */
  | "owner_mismatch"
  /** The user cancelled at Bexio. */
  | "access_denied"
  /** Bad code, nonce or token signature, wrong issuer, or missing claims. */
  | "invalid_callback"
  /** Bexio returned an unexpected error or was unreachable. */
  | "idp_error"
  /** The owner has no grant (for that company / grant id). */
  | "not_connected"
  /** The owner has several grants; pass `companyId` or `grantId`. */
  | "ambiguous_grant"
  /** The refresh token is dead; the user has to reconnect. */
  | "reauth_required"
  /** A stored token can't be decrypted (unknown key id, or it belongs to another grant). */
  | "decryption_failed"
  /** The library was configured incorrectly. */
  | "invalid_config";

export class BexioOAuthError extends Error {
  readonly code: BexioOAuthErrorCode;

  constructor(
    code: BexioOAuthErrorCode,
    message: string,
    options?: { cause?: { name: string; error?: string; status?: number } },
  ) {
    super(message, options);
    this.name = "BexioOAuthError";
    this.code = code;
  }
}

export function isBexioOAuthError(
  value: unknown,
  code?: BexioOAuthErrorCode,
): value is BexioOAuthError {
  return (
    value instanceof BexioOAuthError &&
    (code === undefined || value.code === code)
  );
}
