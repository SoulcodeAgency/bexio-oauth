import type { Keyring } from "./crypto.js";
import type { Duration } from "./duration.js";
import type { Role } from "./permissions.js";
import type { GrantStatus, GrantStore } from "./store/types.js";

export interface BexioOAuthConfig {
  /** From your Bexio OAuth app. */
  clientId: string;
  clientSecret: string;
  /** Must exactly match a redirect URI registered at Bexio. */
  redirectUri: string;
  /** Bexio API scopes your app needs; `BASE_SCOPES` are always added. */
  scopes?: string[];
  /** Encryption keyring (see `generateKey`). */
  keys: Keyring;
  store: GrantStore;
  /** Defaults to Bexio's production issuer. Override only to point at a mock. */
  issuer?: string;
  /** Defaults to `https://api.bexio.com`. Override only to point at a mock. */
  apiBaseUrl?: string;
  /** How long one refresh may hold a grant's lock. Default `"30s"`. */
  refreshLockTtl?: Duration;
  /** Where `callback` redirects when the flow cookie is gone. Default `"/"`. */
  defaultReturnTo?: string;
  /** Custom `fetch` for every outgoing request (tests, proxies). */
  fetch?: typeof fetch;
  /** Clock override for tests. */
  clock?: () => Date;
}

/** A grant as the app sees it: no token material. */
export interface Grant {
  id: string;
  ownerId: string;
  companyId: string;
  companyName: string | null;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  companyUserId: number | null;
  role: Role;
  status: GrantStatus;
  scope: string | null;
  accessExpiresAt: Date | null;
  lastRefreshedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Identifies one grant of an owner. */
export interface GrantSelector {
  ownerId: string;
  companyId?: string;
  grantId?: string;
}

export interface AccessToken {
  accessToken: string;
  expiresAt: Date | null;
  grant: Grant;
}

/** Tokens obtained by your auth framework, for `saveGrant`. */
export interface ExternalTokens {
  accessToken: string;
  refreshToken?: string | null;
  idToken?: string | null;
  /** Access-token expiry; defaults to the access token's `exp` claim. */
  expiresAt?: Date | null;
  scope?: string | null;
}

export interface RefreshIdleResult {
  refreshed: number;
  /** Idle grants another process was refreshing at the same time. */
  skipped: number;
  reauthRequired: number;
  failed: number;
  /**
   * Idle grants not attempted because `timeBudget` ran out (0 when every idle
   * grant of this run was attempted). The next run picks them up first.
   */
  remaining: number;
}

/**
 * How the callback checks the owner. Either the `ownerId` your app derives
 * from the signed-in session (must equal the one passed to `start`), or
 * `authorizeOwner`, which receives the owner recorded at `start` and returns
 * whether the signed-in user may connect Bexio for it. Use the latter when
 * one callback URL serves many owners (e.g. workspaces).
 */
export type CallbackOptions =
  | { ownerId: string }
  | { authorizeOwner: (ownerId: string) => boolean | Promise<boolean> };

export interface CallbackResult {
  grant: Grant;
  returnTo: string;
  /** Contains the `Set-Cookie` that deletes the flow cookie; copy it onto your response. */
  headers: Headers;
}

/** The client returned by `createBexioOAuth`. */
export interface BexioOAuth {
  /**
   * Starts the Connect flow: returns a redirect to Bexio that sets the
   * encrypted flow cookie. Derive `ownerId` from your authenticated session.
   * `returnTo` must be a relative path (default: `defaultReturnTo`).
   */
  start(options: { ownerId: string; returnTo?: string }): Promise<Response>;

  /**
   * Handles the redirect back from Bexio, saves the grant, and redirects to
   * `returnTo` (or `returnTo?bexio_error=<code>` on failure). Only
   * `invalid_config` and non-library errors are thrown.
   */
  callback(request: Request, options: CallbackOptions): Promise<Response>;

  /**
   * Handles the redirect back from Bexio and saves the grant. Throws a
   * `BexioOAuthError` on failure; use `callback` for a ready-made redirect.
   */
  handleCallback(
    request: Request,
    options: CallbackOptions,
  ): Promise<CallbackResult>;

  /**
   * Saves tokens obtained by your auth framework ("Sign in with Bexio").
   * Verifies the tokens' signatures against Bexio's keys first.
   */
  saveGrant(input: { ownerId: string; tokens: ExternalTokens }): Promise<Grant>;

  /**
   * A valid access token for the owner's grant, refreshed when needed.
   * Safe to call from background jobs and from many instances at once.
   */
  getAccessToken(selector: GrantSelector): Promise<AccessToken>;

  /** The owner's grants, without token material. */
  listGrants(query: { ownerId: string }): Promise<Grant[]>;

  /** Revokes the refresh token at Bexio (best effort) and deletes the grant. */
  disconnect(selector: GrantSelector): Promise<void>;

  /**
   * Refreshes active grants not refreshed for `idleFor`, so Bexio doesn't end
   * their offline sessions. Run it on a schedule. `limit` (default 100) caps
   * the grants one run looks at; `timeBudget` stops the run before the next
   * grant once that much time has passed.
   */
  refreshIdle(options: {
    idleFor: Duration;
    limit?: number;
    timeBudget?: Duration;
  }): Promise<RefreshIdleResult>;
}
