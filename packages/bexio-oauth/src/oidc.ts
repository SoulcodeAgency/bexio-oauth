import * as oidc from "openid-client";
import { createRemoteJWKSet, customFetch as joseCustomFetch } from "jose";
import { BexioOAuthError } from "./errors.js";

/** Per HTTP request to Bexio. Kept well below the default refresh lock TTL. */
export const HTTP_TIMEOUT_SECONDS = 10;

/**
 * A safe summary of an upstream error for `BexioOAuthError.cause`: the OAuth
 * error code and HTTP status, never response bodies or token values.
 */
export function describe(error: unknown): {
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

export type KeySet = ReturnType<typeof createRemoteJWKSet>;

/** Bexio's OIDC metadata and signing keys, loaded lazily. */
export interface Oidc {
  /** The discovered configuration; a failed discovery is retried on the next call. */
  config(): Promise<oidc.Configuration>;
  /** Bexio's signing keys (cached, refetched on an unknown key id). */
  keySet(): Promise<KeySet>;
}

export function createOidc(options: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Allow plain http (local mocks only). */
  allowInsecure: boolean;
  fetchImpl: typeof fetch;
}): Oidc {
  const { issuer, clientId, clientSecret, allowInsecure, fetchImpl } = options;
  const issuerUrl = new URL(issuer);
  const customFetch = (url: string, init: RequestInit) => fetchImpl(url, init);

  let discovered: Promise<oidc.Configuration> | undefined;
  function config(): Promise<oidc.Configuration> {
    discovered ??= oidc
      .discovery(issuerUrl, clientId, clientSecret, undefined, {
        execute: allowInsecure ? [oidc.allowInsecureRequests] : [],
        // Well below the refresh lock TTL, so a slow IdP can't outlive the lock.
        timeout: HTTP_TIMEOUT_SECONDS,
        [oidc.customFetch]: customFetch,
      })
      .then((c) => {
        c[oidc.customFetch] = customFetch;
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

  // Cached, refetched on an unknown key id, with a timeout and a cooldown so a
  // bad token can't hammer the issuer.
  let jwks: KeySet | undefined;
  async function keySet(): Promise<KeySet> {
    if (!jwks) {
      const uri = (await config()).serverMetadata().jwks_uri;
      if (!uri)
        throw new BexioOAuthError("idp_error", "issuer publishes no jwks_uri");
      jwks = createRemoteJWKSet(new URL(uri), {
        timeoutDuration: HTTP_TIMEOUT_SECONDS * 1000,
        [joseCustomFetch]: fetchImpl,
      });
    }
    return jwks;
  }

  return { config, keySet };
}
