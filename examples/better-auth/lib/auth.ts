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
          },
        ],
      }),
    ],
    hooks: {
      // Better Auth stores the provider tokens on its `account` row during the
      // OAuth callback. As soon as a session exists, hand them to the library
      // (which verifies, encrypts and refreshes them) and clear Better Auth's
      // copy, so the grant is the only place the Bexio tokens live.
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
        await getBexio().saveGrant({
          ownerId: session.user.id,
          tokens: {
            accessToken: account.accessToken,
            refreshToken: account.refreshToken,
            idToken: account.idToken,
            expiresAt: account.accessTokenExpiresAt,
          },
        });
        await ctx.context.internalAdapter.updateAccount(account.id, {
          accessToken: null,
          refreshToken: null,
          idToken: null,
        });
      }),
    },
  });
}

let auth: ReturnType<typeof buildAuth> | undefined;

/** Built on first use, so `next build` needs no env. */
export function getAuth() {
  return (auth ??= buildAuth());
}
