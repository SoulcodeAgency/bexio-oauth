import { resolveConfig } from "./config.js";
import { callback, handleCallback, start } from "./connect-flow.js";
import { saveGrant } from "./external-tokens.js";
import { disconnect, listGrants } from "./grants.js";
import { refreshIdle } from "./idle-sweep.js";
import { getAccessToken } from "./refresh.js";
import type { BexioOAuth, BexioOAuthConfig } from "./types.js";

/**
 * Creates the client. Validates the config up front (throws `invalid_config`);
 * OIDC discovery runs lazily on first use.
 */
export function createBexioOAuth(config: BexioOAuthConfig): BexioOAuth {
  const ctx = resolveConfig(config);
  return {
    start: (options) => start(ctx, options),
    callback: (request, options) => callback(ctx, request, options),
    handleCallback: (request, options) => handleCallback(ctx, request, options),
    saveGrant: (input) => saveGrant(ctx, input),
    getAccessToken: (selector) => getAccessToken(ctx, selector),
    listGrants: (query) => listGrants(ctx.store, query),
    disconnect: (selector) => disconnect(ctx, selector),
    refreshIdle: (options) => refreshIdle(ctx, options),
  };
}
