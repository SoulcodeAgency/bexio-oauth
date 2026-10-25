import { randomUUID } from "node:crypto";
import * as oidc from "openid-client";
import {
  createRemoteJWKSet,
  customFetch as joseCustomFetch,
  decodeJwt,
  errors as joseErrors,
  jwtVerify,
} from "jose";
import type { JWTPayload } from "jose";
import {
  BASE_SCOPES,
  BEXIO_API_BASE_URL,
  BEXIO_ISSUER,
  grantBinding,
  mapClaims,
  type ClaimBag,
} from "./claims.js";
import { TokenCipher, type Keyring } from "./crypto.js";
import { toMs, type Duration } from "./duration.js";
import { BexioOAuthError, isBexioOAuthError } from "./errors.js";
import { fetchRole, type Role } from "./permissions.js";
import type { GrantRecord, GrantStore } from "./store/types.js";

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
  status: GrantRecord["status"];
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

const FLOW_COOKIE = "bexio_oauth_flow";
const FLOW_TTL_SECONDS = 600;
/** Refresh a little before the access token really expires. */
const EXPIRY_SKEW_MS = 30_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Per HTTP request to Bexio. Kept well below the default refresh lock TTL. */
const HTTP_TIMEOUT_SECONDS = 10;
const SIGNING_ALGORITHMS = ["RS256", "PS256", "ES256"];
const MIN_LOCK_TTL_MS = 30_000;

/**
 * A safe summary of an upstream error for `BexioOAuthError.cause`: the OAuth
 * error code and HTTP status, never response bodies or token values.
 */
function describe(error: unknown): {
  name: string;
  error?: string;
  status?: number;
} {
  if (error instanceof oidc.ResponseBodyError) {
    return { name: error.name, error: error.error, status: error.status };
  }
  if (error instanceof oidc.AuthorizationResponseError) {
    return { name: error.name, error: error.error };
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      ...(typeof code === "string" ? { error: code } : {}),
    };
  }
  return { name: "unknown" };
}

interface FlowState extends JWTPayload {
  /** state */ s: string;
  /** PKCE verifier */ v: string;
  /** nonce */ n: string;
  /** ownerId */ o: string;
  /** returnTo */ r: string;
}

function toGrant(r: GrantRecord): Grant {
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

const RETURN_TO_BASE = "https://return-to.invalid";

/**
 * Only same-origin relative paths: blocks open redirects via `returnTo`.
 * Parsed with the URL parser (the same one the redirect will go through), so
 * tricks like `/\t/evil.example` are caught, and normalized to path+query+hash.
 */
function safeReturnTo(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const invalid = () =>
    new BexioOAuthError(
      "invalid_config",
      "returnTo must be a relative path like /settings",
    );
  // eslint-disable-next-line no-control-regex
  if (!value.startsWith("/") || /[\u0000-\u001f\\]/.test(value))
    throw invalid();
  let url: URL;
  try {
    url = new URL(value, RETURN_TO_BASE);
  } catch {
    throw invalid();
  }
  if (url.origin !== RETURN_TO_BASE) throw invalid();
  // Dot segments can collapse to "//host" (e.g. "/.//evil.example"), which a
  // browser reads as protocol-relative: check the normalized result too.
  if (url.pathname.startsWith("//")) throw invalid();
  return `${url.pathname}${url.search}${url.hash}`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name)
      return part.slice(index + 1).trim();
  }
  return null;
}

function decodeIfJwt(token: string): ClaimBag {
  try {
    return decodeJwt(token) as ClaimBag;
  } catch {
    return {};
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type BexioOAuth = ReturnType<typeof createBexioOAuth>;

export function createBexioOAuth(config: BexioOAuthConfig) {
  for (const key of ["clientId", "clientSecret", "redirectUri"] as const) {
    if (!config[key])
      throw new BexioOAuthError("invalid_config", `${key} is required`);
  }
  if (!config.store)
    throw new BexioOAuthError("invalid_config", "store is required");

  const cipher = new TokenCipher(config.keys);
  const store = config.store;
  const clock = config.clock ?? (() => new Date());
  const fetchImpl = config.fetch ?? fetch;
  const issuer = config.issuer ?? BEXIO_ISSUER;
  const apiBaseUrl = config.apiBaseUrl ?? BEXIO_API_BASE_URL;
  const redirectUri = new URL(config.redirectUri);
  // Plain http only for local development: the flow cookie would otherwise
  // travel without `Secure`.
  if (
    redirectUri.protocol !== "https:" &&
    !(
      redirectUri.protocol === "http:" &&
      LOOPBACK_HOSTS.has(redirectUri.hostname)
    )
  ) {
    throw new BexioOAuthError(
      "invalid_config",
      "redirectUri must use https (http is allowed for loopback hosts only)",
    );
  }
  const scope = [...new Set([...BASE_SCOPES, ...(config.scopes ?? [])])].join(
    " ",
  );
  const lockTtlMs = toMs(config.refreshLockTtl ?? "30s", "refreshLockTtl");
  // One refresh makes up to three Bexio calls inside the lock: token (10 s),
  // the JWKS fetch for the refreshed ID token (10 s), and the role (5 s).
  if (lockTtlMs < MIN_LOCK_TTL_MS) {
    throw new BexioOAuthError(
      "invalid_config",
      `refreshLockTtl must be at least ${MIN_LOCK_TTL_MS / 1000}s`,
    );
  }
  const defaultReturnTo = safeReturnTo(config.defaultReturnTo, "/");
  const issuerUrl = new URL(issuer);
  // http is allowed only for local mocks; real issuers must use https.
  const insecure =
    issuerUrl.protocol === "http:" && LOOPBACK_HOSTS.has(issuerUrl.hostname);

  // ---- OIDC configuration (lazy, retried after a failure) -----------------

  let discovered: Promise<oidc.Configuration> | undefined;
  function oidcConfig(): Promise<oidc.Configuration> {
    discovered ??= oidc
      .discovery(issuerUrl, config.clientId, config.clientSecret, undefined, {
        execute: insecure ? [oidc.allowInsecureRequests] : [],
        // Well below the refresh lock TTL, so a slow IdP can't outlive the lock.
        timeout: HTTP_TIMEOUT_SECONDS,
        [oidc.customFetch]: (url: string, options: RequestInit) =>
          fetchImpl(url, options),
      })
      .then((c) => {
        c[oidc.customFetch] = (url: string, options: RequestInit) =>
          fetchImpl(url, options);
        oidc.enableNonRepudiationChecks(c);
        return c;
      })
      .catch((cause: unknown) => {
        discovered = undefined;
        throw new BexioOAuthError(
          "idp_error",
          `OIDC discovery failed for ${issuer}`,
          { cause: describe(cause) },
        );
      });
    return discovered;
  }

  // Bexio's signing keys (cached, refetched on an unknown key id, with a
  // timeout and a cooldown so a bad token can't hammer the issuer).
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  async function keySet() {
    if (!jwks) {
      const uri = (await oidcConfig()).serverMetadata().jwks_uri;
      if (!uri)
        throw new BexioOAuthError("idp_error", "issuer publishes no jwks_uri");
      jwks = createRemoteJWKSet(new URL(uri), {
        timeoutDuration: HTTP_TIMEOUT_SECONDS * 1000,
        [joseCustomFetch]: fetchImpl,
      });
    }
    return jwks;
  }

  // ---- Grants ----------------------------------------------------------------

  async function resolveGrant(selector: GrantSelector): Promise<GrantRecord> {
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

  async function saveTokens(input: {
    ownerId: string;
    claims: ClaimBag;
    accessToken: string;
    refreshToken: string | null;
    accessExpiresAt: Date | null;
    refreshExpiresAt: Date | null;
    scope: string | null;
  }): Promise<GrantRecord> {
    const identity = mapClaims(input.claims);
    const binding = grantBinding(
      input.ownerId,
      identity.companyId,
      identity.userId,
    );
    const role =
      (await fetchRole(fetchImpl, apiBaseUrl, input.accessToken)) ?? "member";
    return store.upsertGrant({
      ownerId: input.ownerId,
      ...identity,
      role,
      accessToken: await cipher.encrypt(input.accessToken, binding),
      refreshToken: input.refreshToken
        ? await cipher.encrypt(input.refreshToken, binding)
        : null,
      accessExpiresAt: input.accessExpiresAt,
      refreshExpiresAt: input.refreshExpiresAt,
      scope: input.scope,
      now: clock(),
    });
  }

  /** Claims from userinfo, only when the tokens lack the company claims. */
  async function withUserInfo(
    claims: ClaimBag,
    accessToken: string,
  ): Promise<ClaimBag> {
    if (claims.company_id !== undefined) return claims;
    try {
      const info = await oidc.fetchUserInfo(
        await oidcConfig(),
        accessToken,
        typeof claims.sub === "string" ? claims.sub : oidc.skipSubjectCheck,
      );
      return { ...info, ...claims };
    } catch {
      return claims;
    }
  }

  function decryptFor(record: GrantRecord, value: string): Promise<string> {
    return cipher.decrypt(
      value,
      grantBinding(record.ownerId, record.companyId, record.userId),
    );
  }

  /**
   * Refreshes a grant whose lock the caller holds (`lockToken`). Every write
   * is fenced by the token: if the lock was lost (expired and taken over, or
   * the grant was reconnected meanwhile), the write changes nothing and this
   * returns `null`: the caller re-reads the grant.
   */
  async function refreshLocked(
    record: GrantRecord,
    lockToken: string,
  ): Promise<GrantRecord | null> {
    if (!record.refreshToken) {
      await store.markReauthRequired(record.id, lockToken, clock());
      throw new BexioOAuthError(
        "reauth_required",
        "grant has no refresh token; reconnect required",
      );
    }
    let refreshToken: string;
    try {
      refreshToken = await decryptFor(record, record.refreshToken);
    } catch (error) {
      // Usually a keyring mistake (a key removed too early): don't burn the
      // grant, so restoring the key fixes it.
      await store.releaseRefreshLock(record.id, lockToken);
      throw error;
    }

    let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
    try {
      tokens = await oidc.refreshTokenGrant(await oidcConfig(), refreshToken);
    } catch (error) {
      if (
        error instanceof oidc.ResponseBodyError &&
        error.error === "invalid_grant"
      ) {
        await store.markReauthRequired(record.id, lockToken, clock());
        throw new BexioOAuthError(
          "reauth_required",
          "Bexio rejected the refresh token; reconnect required",
          { cause: describe(error) },
        );
      }
      await store.releaseRefreshLock(record.id, lockToken);
      if (isBexioOAuthError(error)) throw error;
      throw new BexioOAuthError("idp_error", "token refresh failed", {
        cause: describe(error),
      });
    }

    const now = clock();
    const binding = grantBinding(
      record.ownerId,
      record.companyId,
      record.userId,
    );
    const expiresIn = tokens.expiresIn();
    const refreshExpiresIn = Number(tokens.refresh_expires_in);
    const saved = await store.saveRefreshed(record.id, lockToken, {
      accessToken: await cipher.encrypt(tokens.access_token, binding),
      refreshToken: tokens.refresh_token
        ? await cipher.encrypt(tokens.refresh_token, binding)
        : null,
      accessExpiresAt:
        expiresIn === undefined
          ? null
          : new Date(now.getTime() + expiresIn * 1000),
      refreshExpiresAt:
        Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0
          ? new Date(now.getTime() + refreshExpiresIn * 1000)
          : null,
      scope: tokens.scope ?? null,
      role: await fetchRole(fetchImpl, apiBaseUrl, tokens.access_token),
      now,
    });
    // null: lock lost while refreshing (someone reconnected, or our lock
    // expired and another caller took over). Their write wins.
    return saved;
  }

  function isFresh(record: GrantRecord, now: Date): boolean {
    return (
      record.accessExpiresAt !== null &&
      record.accessExpiresAt.getTime() - EXPIRY_SKEW_MS > now.getTime()
    );
  }

  async function issue(record: GrantRecord): Promise<AccessToken> {
    return {
      accessToken: await decryptFor(record, record.accessToken),
      expiresAt: record.accessExpiresAt,
      grant: toGrant(record),
    };
  }

  function lockWindow(now: Date) {
    return {
      now,
      lockUntil: new Date(now.getTime() + lockTtlMs),
      lockToken: randomUUID(),
    };
  }

  // ---- Public API ------------------------------------------------------------

  const api = {
    /**
     * Starts the Connect flow: redirects to Bexio and sets the encrypted flow
     * cookie. Derive `ownerId` from your authenticated session.
     */
    async start(
      _request: Request,
      options: { ownerId: string; returnTo?: string },
    ): Promise<Response> {
      if (!options?.ownerId)
        throw new BexioOAuthError("invalid_config", "ownerId is required");
      const returnTo = safeReturnTo(options.returnTo, defaultReturnTo);
      const c = await oidcConfig();
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const url = oidc.buildAuthorizationUrl(c, {
        redirect_uri: redirectUri.href,
        scope,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
        nonce,
      });
      const sealed = await cipher.seal(
        {
          s: state,
          v: verifier,
          n: nonce,
          o: options.ownerId,
          r: returnTo,
        } satisfies FlowState,
        FLOW_TTL_SECONDS,
        clock(),
      );
      const headers = new Headers({
        Location: url.href,
        "Cache-Control": "no-store",
      });
      headers.append("Set-Cookie", flowCookie(sealed, FLOW_TTL_SECONDS));
      return new Response(null, { status: 302, headers });
    },

    /**
     * Handles the redirect back from Bexio and saves the grant. Throws a
     * `BexioOAuthError` on failure; use `callback` for a ready-made redirect.
     */
    async handleCallback(
      request: Request,
      options: CallbackOptions,
    ): Promise<CallbackResult> {
      if (
        !options ||
        ("ownerId" in options
          ? !options.ownerId
          : typeof options.authorizeOwner !== "function")
      ) {
        throw new BexioOAuthError(
          "invalid_config",
          "pass ownerId or authorizeOwner",
        );
      }
      const sealed = readCookie(request, FLOW_COOKIE);
      const flow = sealed
        ? ((await cipher.unseal(sealed, clock())) as FlowState | null)
        : null;
      const params = new URL(request.url).searchParams;
      if (!flow || params.get("state") !== flow.s) {
        throw new BexioOAuthError(
          "state_mismatch",
          "flow cookie missing or expired, or state mismatch",
        );
      }
      const ownerAllowed =
        "ownerId" in options
          ? flow.o === options.ownerId
          : (await options.authorizeOwner(flow.o)) === true;
      if (!ownerAllowed) {
        throw new BexioOAuthError(
          "owner_mismatch",
          "the signed-in user may not connect Bexio for the owner used at start",
        );
      }
      const error = params.get("error");
      if (error) {
        throw new BexioOAuthError(
          error === "access_denied" ? "access_denied" : "idp_error",
          `Bexio returned ${error}`,
        );
      }

      // Rebuild the URL on the registered redirect URI, so a proxy that rewrites
      // the host doesn't change the redirect_uri sent to the token endpoint.
      const currentUrl = new URL(redirectUri.href);
      currentUrl.search = params.toString();

      const c = await oidcConfig();
      let tokens: oidc.TokenEndpointResponse &
        oidc.TokenEndpointResponseHelpers;
      try {
        tokens = await oidc.authorizationCodeGrant(c, currentUrl, {
          pkceCodeVerifier: flow.v,
          expectedState: flow.s,
          expectedNonce: flow.n,
          idTokenExpected: true,
        });
      } catch (cause) {
        if (cause instanceof oidc.AuthorizationResponseError) {
          throw new BexioOAuthError(
            cause.error === "access_denied" ? "access_denied" : "idp_error",
            `Bexio returned ${cause.error}`,
            { cause: describe(cause) },
          );
        }
        if (cause instanceof TypeError) {
          throw new BexioOAuthError(
            "idp_error",
            "Bexio token endpoint unreachable",
            { cause: describe(cause) },
          );
        }
        throw new BexioOAuthError(
          "invalid_callback",
          "authorization code exchange or ID token validation failed",
          { cause: describe(cause) },
        );
      }

      const now = clock();
      const expiresIn = tokens.expiresIn();
      const refreshExpiresIn = Number(tokens.refresh_expires_in);
      const claims = await withUserInfo(
        { ...decodeIfJwt(tokens.access_token), ...(tokens.claims() ?? {}) },
        tokens.access_token,
      );
      const record = await saveTokens({
        ownerId: flow.o,
        claims,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        accessExpiresAt:
          expiresIn === undefined
            ? null
            : new Date(now.getTime() + expiresIn * 1000),
        refreshExpiresAt:
          Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0
            ? new Date(now.getTime() + refreshExpiresIn * 1000)
            : null,
        scope: tokens.scope ?? null,
      });
      const headers = new Headers();
      headers.append("Set-Cookie", flowCookie("", 0));
      return { grant: toGrant(record), returnTo: flow.r, headers };
    },

    /**
     * Handles the redirect back from Bexio, saves the grant, and redirects to
     * `returnTo` (or `returnTo?bexio_error=<code>` on failure).
     */
    async callback(
      request: Request,
      options: CallbackOptions,
    ): Promise<Response> {
      const headers = new Headers({ "Cache-Control": "no-store" });
      headers.append("Set-Cookie", flowCookie("", 0));
      let location: URL;
      try {
        const result = await api.handleCallback(request, options);
        location = new URL(result.returnTo, redirectUri.origin);
      } catch (error) {
        if (!isBexioOAuthError(error) || error.code === "invalid_config")
          throw error;
        const sealed = readCookie(request, FLOW_COOKIE);
        const flow = sealed
          ? ((await cipher.unseal(sealed, clock())) as FlowState | null)
          : null;
        location = new URL(flow?.r ?? defaultReturnTo, redirectUri.origin);
        location.searchParams.set("bexio_error", error.code);
      }
      headers.set("Location", location.href);
      return new Response(null, { status: 302, headers });
    },

    /**
     * Saves tokens obtained by your auth framework ("Sign in with Bexio").
     * Verifies the tokens' signatures against Bexio's keys first.
     */
    async saveGrant(input: {
      ownerId: string;
      tokens: ExternalTokens;
    }): Promise<Grant> {
      if (!input?.ownerId)
        throw new BexioOAuthError("invalid_config", "ownerId is required");
      const { tokens } = input;
      if (!tokens?.accessToken)
        throw new BexioOAuthError(
          "invalid_config",
          "tokens.accessToken is required",
        );
      const c = await oidcConfig();
      const expectedIssuer = c.serverMetadata().issuer;
      const verify = async (
        token: string,
        audience?: string,
      ): Promise<ClaimBag> => {
        const keys = await keySet();
        try {
          const { payload } = await jwtVerify(token, keys, {
            issuer: expectedIssuer,
            audience,
            algorithms: SIGNING_ALGORITHMS,
            currentDate: clock(),
          });
          return payload as ClaimBag;
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
      };
      const accessClaims = await verify(tokens.accessToken);
      // Must be an access token issued to this app: rejects tokens issued to
      // another client (token substitution) and ID tokens passed as access tokens.
      if (accessClaims.azp !== config.clientId) {
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
        ? await verify(tokens.idToken, config.clientId)
        : {};
      if (tokens.idToken && idClaims.sub !== accessClaims.sub) {
        throw new BexioOAuthError(
          "invalid_callback",
          "ID token and access token belong to different users",
        );
      }
      const claims = await withUserInfo(
        { ...accessClaims, ...idClaims },
        tokens.accessToken,
      );
      const exp =
        typeof accessClaims.exp === "number"
          ? new Date(accessClaims.exp * 1000)
          : null;
      const record = await saveTokens({
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
    },

    /**
     * A valid access token for the owner's grant, refreshed when needed.
     * Safe to call from background jobs and from many instances at once.
     */
    async getAccessToken(selector: GrantSelector): Promise<AccessToken> {
      let record = await resolveGrant(selector);
      const deadline = clock().getTime() + lockTtlMs + 5_000;
      let wait = 50;
      for (;;) {
        if (record.status === "reauth_required") {
          throw new BexioOAuthError(
            "reauth_required",
            "grant needs to be reconnected",
          );
        }
        const now = clock();
        if (isFresh(record, now)) return issue(record);

        // Discovery outside the lock, so a cold start doesn't eat into it.
        await oidcConfig();
        const window = lockWindow(clock());
        const locked = await store.acquireRefreshLock({
          id: record.id,
          ...window,
          accessExpiresBefore: new Date(now.getTime() + EXPIRY_SKEW_MS),
        });
        if (locked) {
          const refreshed = await refreshLocked(locked, window.lockToken);
          if (refreshed) return issue(refreshed);
          // Lost the lock to a reconnect or another refresher: look at their
          // result before anything else (it may be fresh, or reauth_required).
          const current = await store.getGrant(record.id);
          if (!current)
            throw new BexioOAuthError("not_connected", "grant was deleted");
          record = current;
          continue;
        }

        // Someone else is refreshing (or just did): wait for their result.
        if (clock().getTime() > deadline) {
          throw new BexioOAuthError(
            "idp_error",
            "timed out waiting for a concurrent token refresh",
          );
        }
        await sleep(wait);
        wait = Math.min(wait * 2, 1_000);
        const next = await store.getGrant(record.id);
        if (!next)
          throw new BexioOAuthError("not_connected", "grant was deleted");
        record = next;
      }
    },

    /** The owner's grants, without token material. */
    async listGrants(query: { ownerId: string }): Promise<Grant[]> {
      if (!query?.ownerId)
        throw new BexioOAuthError("invalid_config", "ownerId is required");
      return (await store.findGrants({ ownerId: query.ownerId })).map(toGrant);
    },

    /** Revokes the refresh token at Bexio (best effort) and deletes the grant. */
    async disconnect(selector: GrantSelector): Promise<void> {
      const record = await resolveGrant(selector);
      try {
        const c = await oidcConfig();
        if (record.refreshToken && c.serverMetadata().revocation_endpoint) {
          await oidc.tokenRevocation(
            c,
            await decryptFor(record, record.refreshToken),
            {
              token_type_hint: "refresh_token",
            },
          );
        }
      } catch {
        // Revocation is best effort; the grant is deleted either way.
      }
      await store.deleteGrant(record.id);
    },

    /**
     * Refreshes active grants not refreshed for `idleFor`, so Bexio doesn't end
     * their offline sessions. Run it on a schedule.
     */
    async refreshIdle(options: {
      idleFor: Duration;
      limit?: number;
    }): Promise<RefreshIdleResult> {
      const idleMs = toMs(options?.idleFor, "idleFor");
      const result: RefreshIdleResult = {
        refreshed: 0,
        skipped: 0,
        reauthRequired: 0,
        failed: 0,
      };
      const refreshedBefore = new Date(clock().getTime() - idleMs);
      const idle = await store.listIdleGrants({
        refreshedBefore,
        limit: options.limit ?? 500,
      });
      if (idle.length === 0) return result;
      try {
        await oidcConfig();
      } catch {
        // Bexio unreachable: report, don't throw; the next run retries.
        result.failed = idle.length;
        return result;
      }
      for (const grant of idle) {
        const window = lockWindow(clock());
        const locked = await store.acquireRefreshLock({
          id: grant.id,
          ...window,
          refreshedBefore,
        });
        if (!locked) {
          result.skipped++;
          continue;
        }
        try {
          if (await refreshLocked(locked, window.lockToken)) result.refreshed++;
          else result.skipped++;
        } catch (error) {
          if (isBexioOAuthError(error, "reauth_required")) {
            result.reauthRequired++;
          } else {
            result.failed++;
          }
        }
      }
      return result;
    },
  };
  return api;

  function flowCookie(value: string, maxAge: number): string {
    const parts = [
      `${FLOW_COOKIE}=${value}`,
      `Path=${redirectUri.pathname}`,
      `Max-Age=${maxAge}`,
      "HttpOnly",
      "SameSite=Lax",
    ];
    if (redirectUri.protocol === "https:") parts.push("Secure");
    return parts.join("; ");
  }
}
