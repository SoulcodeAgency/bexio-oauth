import { BASE_SCOPES, BEXIO_API_BASE_URL, BEXIO_ISSUER } from "./claims.js";
import { TokenCipher } from "./crypto.js";
import { toMs } from "./duration.js";
import { BexioOAuthError } from "./errors.js";
import { createOidc, type Oidc } from "./oidc.js";
import { safeReturnTo } from "./return-to.js";
import type { GrantStore } from "./store/types.js";
import type { BexioOAuthConfig } from "./types.js";

/** The validated configuration and shared services every client method uses. */
export interface ClientContext {
  clientId: string;
  cipher: TokenCipher;
  store: GrantStore;
  clock: () => Date;
  fetchImpl: typeof fetch;
  oidc: Oidc;
  apiBaseUrl: string;
  redirectUri: URL;
  /** Space-separated, `BASE_SCOPES` included. */
  scope: string;
  lockTtlMs: number;
  defaultReturnTo: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/**
 * One refresh makes up to three Bexio calls inside the lock: token (10 s), the
 * JWKS fetch for the refreshed ID token (10 s), and the role (5 s).
 */
const MIN_LOCK_TTL_MS = 30_000;

const isLoopbackHttp = (url: URL) =>
  url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);

/** Validates the config (throws `invalid_config`) and builds the shared context. */
export function resolveConfig(config: BexioOAuthConfig): ClientContext {
  for (const key of ["clientId", "clientSecret", "redirectUri"] as const) {
    if (!config[key])
      throw new BexioOAuthError("invalid_config", `${key} is required`);
  }
  if (!config.store)
    throw new BexioOAuthError("invalid_config", "store is required");

  const cipher = new TokenCipher(config.keys);
  const fetchImpl = config.fetch ?? fetch;
  const issuer = config.issuer ?? BEXIO_ISSUER;
  const redirectUri = new URL(config.redirectUri);
  // Plain http only for local development: the flow cookie would otherwise
  // travel without `Secure`.
  if (redirectUri.protocol !== "https:" && !isLoopbackHttp(redirectUri)) {
    throw new BexioOAuthError(
      "invalid_config",
      "redirectUri must use https (http is allowed for loopback hosts only)",
    );
  }
  const lockTtlMs = toMs(config.refreshLockTtl ?? "30s", "refreshLockTtl");
  if (lockTtlMs < MIN_LOCK_TTL_MS) {
    throw new BexioOAuthError(
      "invalid_config",
      `refreshLockTtl must be at least ${MIN_LOCK_TTL_MS / 1000}s`,
    );
  }
  const defaultReturnTo = safeReturnTo(config.defaultReturnTo, "/");

  return {
    clientId: config.clientId,
    cipher,
    store: config.store,
    clock: config.clock ?? (() => new Date()),
    fetchImpl,
    oidc: createOidc({
      issuer,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      // http is allowed only for local mocks; real issuers must use https.
      allowInsecure: isLoopbackHttp(new URL(issuer)),
      fetchImpl,
    }),
    apiBaseUrl: config.apiBaseUrl ?? BEXIO_API_BASE_URL,
    redirectUri,
    scope: [...new Set([...BASE_SCOPES, ...(config.scopes ?? [])])].join(" "),
    lockTtlMs,
    defaultReturnTo,
  };
}
