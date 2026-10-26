import * as oidc from "openid-client";
import type { ClientContext } from "./config.js";
import { BexioOAuthError, isBexioOAuthError } from "./errors.js";
import {
  FLOW_TTL_SECONDS,
  flowCookie,
  readFlow,
  sealFlow,
  type FlowState,
} from "./flow-cookie.js";
import { decodeIfJwt, saveTokens, toGrant, withUserInfo } from "./grants.js";
import { describe } from "./oidc.js";
import { tokenExpiry, type TokenResponse } from "./refresh.js";
import { safeReturnTo } from "./return-to.js";
import type { CallbackOptions, CallbackResult } from "./types.js";

/** `BexioOAuth.start`. */
export async function start(
  ctx: ClientContext,
  options: { ownerId: string; returnTo?: string },
): Promise<Response> {
  if (!options?.ownerId)
    throw new BexioOAuthError("invalid_config", "ownerId is required");
  const returnTo = safeReturnTo(options.returnTo, ctx.defaultReturnTo);
  const c = await ctx.oidc.config();
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(c, {
    redirect_uri: ctx.redirectUri.href,
    scope: ctx.scope,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });
  const sealed = await sealFlow(
    ctx.cipher,
    { s: state, v: verifier, n: nonce, o: options.ownerId, r: returnTo },
    ctx.clock(),
  );
  const headers = new Headers({
    Location: url.href,
    "Cache-Control": "no-store",
  });
  headers.append(
    "Set-Cookie",
    flowCookie(ctx.redirectUri, sealed, FLOW_TTL_SECONDS),
  );
  return new Response(null, { status: 302, headers });
}

/** `BexioOAuth.handleCallback`. */
export async function handleCallback(
  ctx: ClientContext,
  request: Request,
  options: CallbackOptions,
): Promise<CallbackResult> {
  assertCallbackOptions(options);
  return completeCallback(
    ctx,
    request,
    options,
    await readFlow(ctx.cipher, request, ctx.clock()),
  );
}

/**
 * `BexioOAuth.callback`: reads the flow cookie once, so a failure can still
 * redirect to the `returnTo` it recorded.
 */
export async function callback(
  ctx: ClientContext,
  request: Request,
  options: CallbackOptions,
): Promise<Response> {
  const headers = new Headers({ "Cache-Control": "no-store" });
  headers.append("Set-Cookie", flowCookie(ctx.redirectUri, "", 0));
  const origin = ctx.redirectUri.origin;
  assertCallbackOptions(options);
  const flow = await readFlow(ctx.cipher, request, ctx.clock());
  let location: URL;
  try {
    const result = await completeCallback(ctx, request, options, flow);
    location = new URL(result.returnTo, origin);
  } catch (error) {
    if (!isBexioOAuthError(error) || error.code === "invalid_config")
      throw error;
    location = new URL(flow?.r ?? ctx.defaultReturnTo, origin);
    location.searchParams.set("bexio_error", error.code);
  }
  headers.set("Location", location.href);
  return new Response(null, { status: 302, headers });
}

function assertCallbackOptions(options: CallbackOptions): void {
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
}

/** The callback after the flow cookie was read (`flow` is null when unreadable). */
async function completeCallback(
  ctx: ClientContext,
  request: Request,
  options: CallbackOptions,
  flow: FlowState | null,
): Promise<CallbackResult> {
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
  const currentUrl = new URL(ctx.redirectUri.href);
  currentUrl.search = params.toString();

  const c = await ctx.oidc.config();
  let tokens: TokenResponse;
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

  const now = ctx.clock();
  const claims = await withUserInfo(
    ctx,
    { ...decodeIfJwt(tokens.access_token), ...(tokens.claims() ?? {}) },
    tokens.access_token,
  );
  const record = await saveTokens(ctx, {
    ownerId: flow.o,
    claims,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    ...tokenExpiry(tokens, now),
    scope: tokens.scope ?? null,
  });
  const headers = new Headers();
  headers.append("Set-Cookie", flowCookie(ctx.redirectUri, "", 0));
  return { grant: toGrant(record), returnTo: flow.r, headers };
}
