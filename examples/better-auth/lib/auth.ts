import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins";
import { BASE_SCOPES, BEXIO_ISSUER } from "@soulcode/bexio-oauth";
import { getBexio } from "./bexio";
import { getPool } from "./db";
import { env, optionalEnv } from "./env";

function buildAuth() {
  const issuer = optionalEnv("BEXIO_ISSUER") ?? BEXIO_ISSUER;
  return betterAuth({
    baseURL: env("APP_URL"),
    secret: env("BETTER_AUTH_SECRET"),
    database: getPool(),
    // On by default in production; the e2e suite signs in many times in a row.
    rateLimit: { enabled: process.env.AUTH_RATE_LIMIT !== "off" },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: "bexio",
            clientId: env("BEXIO_CLIENT_ID"),
            clientSecret: env("BEXIO_CLIENT_SECRET"),
            discoveryUrl: `${issuer}/.well-known/openid-configuration`,
            scopes: [
              ...BASE_SCOPES,
              ...(process.env.BEXIO_SCOPES ?? "").split(" ").filter(Boolean),
            ],
            pkce: true,
            // Bexio sends given_name and family_name, but no name claim.
            // overrideUserInfo applies the mapping on every sign-in, not
            // only at sign-up, so names changed at Bexio follow too.
            overrideUserInfo: true,
            mapProfileToUser: (profile) => {
              const name = [profile.given_name, profile.family_name]
                .filter((part) => typeof part === "string" && part)
                .join(" ");
              return name ? { name } : {};
            },
          },
        ],
      }),
    ],
    hooks: {
      // Better Auth stores the provider tokens on its `account` row during the
      // OAuth callback. As soon as a session exists, hand them to the library
      // (which verifies, encrypts and refreshes them) and clear Better Auth's
      // copy, so the grant is the only place the Bexio tokens live.
      //
      // Deliberately route-independent (no `ctx.path` check): a new session
      // with Bexio tokens on the account can only come from the OAuth
      // callback, and the check survives Better Auth renaming its routes.
      // Notes for copying this: keep `account.encryptOAuthTokens` off (the
      // library encrypts), and `linkSocial` (linking Bexio to an existing
      // user) creates no new session, so it needs the same hand-over.
      after: createAuthMiddleware(async (ctx) => {
        const session = ctx.context.newSession;
        if (!session) return;
        const accounts = await ctx.context.internalAdapter.findAccounts(
          session.user.id,
        );
        const account = accounts.find(
          (a) => a.providerId === "bexio" && a.accessToken,
        );
        if (!account?.accessToken) return;
        try {
          await getBexio().saveGrant({
            ownerId: session.user.id,
            tokens: {
              accessToken: account.accessToken,
              refreshToken: account.refreshToken,
              idToken: account.idToken,
              expiresAt: account.accessTokenExpiresAt,
            },
          });
        } finally {
          // Even if saveGrant failed: never leave the tokens on Better Auth's row.
          await ctx.context.internalAdapter.updateAccount(account.id, {
            accessToken: null,
            refreshToken: null,
            idToken: null,
          });
        }
      }),
    },
  });
}

let auth: ReturnType<typeof buildAuth> | undefined;

/** Built on first use, so `next build` needs no env. */
export function getAuth() {
  return (auth ??= buildAuth());
}
