import { randomUUID } from "node:crypto";
import * as oidc from "openid-client";
import type { ClientContext } from "./config.js";
import { BexioOAuthError, isBexioOAuthError } from "./errors.js";
import { bindingOf, decryptFor, issue, resolveGrant } from "./grants.js";
import { describe } from "./oidc.js";
import { fetchRole } from "./permissions.js";
import type { ConnectionRecord } from "./store/types.js";
import type { AccessToken, GrantSelector } from "./types.js";

/** Refresh a little before the access token really expires. */
export const EXPIRY_SKEW_MS = 30_000;
/** Extra time `getAccessToken` waits for a concurrent refresh beyond the lock TTL. */
const WAIT_GRACE_MS = 5_000;

export type TokenResponse = oidc.TokenEndpointResponse &
  oidc.TokenEndpointResponseHelpers;

/** Absolute expiries from a token response's `expires_in` / `refresh_expires_in`. */
export function tokenExpiry(
  tokens: TokenResponse,
  now: Date,
): { accessExpiresAt: Date | null; refreshExpiresAt: Date | null } {
  const expiresIn = tokens.expiresIn();
  const refreshExpiresIn = Number(tokens.refresh_expires_in);
  return {
    accessExpiresAt:
      expiresIn === undefined
        ? null
        : new Date(now.getTime() + expiresIn * 1000),
    refreshExpiresAt:
      Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0
        ? new Date(now.getTime() + refreshExpiresIn * 1000)
        : null,
  };
}

/** True while the access token is valid for longer than the skew. */
export function isFresh(connection: ConnectionRecord, now: Date): boolean {
  return (
    connection.accessExpiresAt !== null &&
    connection.accessExpiresAt.getTime() - EXPIRY_SKEW_MS > now.getTime()
  );
}

/** A new lock holder's token and lease, starting at `now`. */
export function lockWindow(ctx: ClientContext, now: Date) {
  return {
    now,
    lockUntil: new Date(now.getTime() + ctx.lockTtlMs),
    lockToken: randomUUID(),
  };
}

/**
 * Refreshes a connection whose lock the caller holds (`lockToken`). Every
 * write is fenced by the token: if the lock was lost (expired and taken over,
 * or the connection was reconnected meanwhile), the write changes nothing and
 * this returns `null`: the caller re-reads the connection.
 */
export async function refreshLocked(
  ctx: ClientContext,
  connection: ConnectionRecord,
  lockToken: string,
): Promise<ConnectionRecord | null> {
  const { store, cipher, clock } = ctx;
  if (!connection.refreshToken) {
    if (!(await store.markReauthRequired(connection.id, lockToken, clock())))
      return null;
    throw new BexioOAuthError(
      "reauth_required",
      "connection has no refresh token; reconnect required",
    );
  }
  let refreshToken: string;
  try {
    refreshToken = await decryptFor(
      cipher,
      connection,
      connection.refreshToken,
    );
  } catch (error) {
    // Usually a keyring mistake (a key removed too early): don't burn the
    // connection, so restoring the key fixes it.
    await store.releaseRefreshLock(connection.id, lockToken);
    throw error;
  }

  let tokens: TokenResponse;
  try {
    tokens = await oidc.refreshTokenGrant(
      await ctx.oidc.config(),
      refreshToken,
    );
  } catch (error) {
    if (
      error instanceof oidc.ResponseBodyError &&
      error.error === "invalid_grant"
    ) {
      // A reconnect during the refresh restarts the chain at Bexio, which
      // rejects this (older) refresh token. If the reconnect's write already
      // landed, it cleared our lock: nothing is marked and the caller reads
      // the new tokens. If it lands later, it revives the connection then.
      if (!(await store.markReauthRequired(connection.id, lockToken, clock())))
        return null;
      throw new BexioOAuthError(
        "reauth_required",
        "Bexio rejected the refresh token; reconnect required",
        { cause: describe(error) },
      );
    }
    await store.releaseRefreshLock(connection.id, lockToken);
    if (isBexioOAuthError(error)) throw error;
    throw new BexioOAuthError("idp_error", "token refresh failed", {
      cause: describe(error),
    });
  }

  const now = clock();
  const binding = bindingOf(connection);
  // null: lock lost while refreshing (someone reconnected, or our lock
  // expired and another caller took over). Their write wins.
  return store.saveRefreshed(connection.id, lockToken, {
    accessToken: await cipher.encrypt(tokens.access_token, binding),
    refreshToken: tokens.refresh_token
      ? await cipher.encrypt(tokens.refresh_token, binding)
      : null,
    ...tokenExpiry(tokens, now),
    scope: tokens.scope ?? null,
    role: await fetchRole(ctx.fetchImpl, ctx.apiBaseUrl, tokens.access_token),
    now,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `BexioOAuth.getAccessToken`. */
export async function getAccessToken(
  ctx: ClientContext,
  selector: GrantSelector,
): Promise<AccessToken> {
  const { store, clock } = ctx;
  const grant = await resolveGrant(store, selector);
  let connection = grant.connection;
  const deadline = clock().getTime() + ctx.lockTtlMs + WAIT_GRACE_MS;
  let wait = 50;
  const reread = async () => {
    const current = await store.getConnection(connection.id);
    if (!current)
      throw new BexioOAuthError("not_connected", "grant was disconnected");
    return current;
  };
  for (;;) {
    if (connection.status === "reauth_required") {
      throw new BexioOAuthError(
        "reauth_required",
        "grant needs to be reconnected",
      );
    }
    const now = clock();
    if (isFresh(connection, now)) return issue(ctx.cipher, grant, connection);
    // Every iteration that would do more work is bounded, whether the last
    // one waited for another refresher or lost its own lock.
    if (now.getTime() > deadline) {
      throw new BexioOAuthError(
        "idp_error",
        "timed out waiting for a concurrent token refresh",
      );
    }

    // Discovery outside the lock, so a cold start doesn't eat into it.
    await ctx.oidc.config();
    const window = lockWindow(ctx, clock());
    const locked = await store.acquireRefreshLock({
      id: connection.id,
      ...window,
      accessExpiresBefore: new Date(now.getTime() + EXPIRY_SKEW_MS),
    });
    if (locked) {
      const refreshed = await refreshLocked(ctx, locked, window.lockToken);
      if (refreshed) return issue(ctx.cipher, grant, refreshed);
      // Lost the lock to a reconnect or another refresher: look at their
      // result before anything else (it may be fresh, or reauth_required).
      connection = await reread();
      continue;
    }

    // Someone else (possibly for another owner of this connection) is
    // refreshing, or just did: wait for their result.
    await sleep(wait);
    wait = Math.min(wait * 2, 1_000);
    connection = await reread();
  }
}
