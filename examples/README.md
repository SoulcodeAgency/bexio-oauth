# Examples

Runnable apps that show `@soulcode/bexio-oauth` inside real auth stacks. They are the recipes behind [docs/integration.md §8](../docs/integration.md#8-sign-in-with-bexio).

| App                                        | Auth                             | Database                              | Shows                                                                                                                                                                                                                                                                   | e2e               |
| ------------------------------------------ | -------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| [`better-auth`](better-auth)               | Better Auth `genericOAuth`       | Plain Postgres (`pg`)                 | **Sign in with Bexio** → `saveGrant`; **Connect Bexio** for workspaces (`authorizeOwner`); a background job; the `refreshIdle` cron; reconnect after `reauth_required`; two workspaces sharing one Bexio connection; [test tools](#better-auth) for live Bexio accounts | 7 tests, every PR |
| [`supabase`](supabase)                     | Supabase Auth (email + password) | Local Supabase (`pg` to its Postgres) | **Connect Bexio** for a Supabase user; RLS keeps both tables unreadable through the API; **Sign in with Bexio** through a custom OIDC provider (live Bexio only, see [Supabase](#supabase))                                                                             | 1 test, every PR  |
| [`_shared/mock-bexio`](_shared/mock-bexio) | –                                | –                                     | A mock of Bexio's Keycloak (PKCE, rotating refresh tokens with reuse detection, one token chain per user and company, Bexio's claim split) and `/3.0/permissions`                                                                                                       | unit tests        |

## Running them

```bash
npm ci && npm run build                      # from the repo root: builds the library
cd examples/better-auth
cp .env.example .env.local                   # then fill in BEXIO_TOKEN_KEYS (npx @soulcode/bexio-oauth keygen)
MOCK_BEXIO_PORT=9401 node ../_shared/mock-bexio/src/server.ts   # in a second terminal (9402 for the Supabase app)
npm run migrate && npm run dev               # http://localhost:3400
```

The Supabase example needs Docker: `npm run db:start` in `examples/supabase` starts the local stack and applies `supabase/migrations/` (generated with `npx @soulcode/bexio-oauth sql`, plus `ENABLE ROW LEVEL SECURITY` on both tables).

`npm run test:e2e` in either app starts the mock and the app itself (Playwright `webServer`). If a dev server already holds the Better Auth ports, run it with `E2E_APP_PORT=3410 E2E_MOCK_PORT=9411`.

For a live Bexio account, leave `BEXIO_ISSUER` and `BEXIO_API_BASE_URL` empty in `.env.local`.

## Better Auth

- **Test tools.** Every connection gets buttons to **expire its access token** (the next page load refreshes), **revoke** its refresh token at Bexio without disconnecting, and **save** a refresh token to **revoke it later**, after a reconnect made it stale ([`lib/test-tools.ts`](better-auth/lib/test-tools.ts)). They decrypt a token straight from the library's table, which a real app never does: don't copy them into a production app. `BEXIO_TEST_TOOLS=off` hides them.
- **Give the app its own Bexio OAuth client.** Better Auth's sign-in and the library's Connect flow both authorize with it, and Bexio keeps one token chain per user, company and client: an app that shares the client id with another app invalidates that app's grants for the same user ([integration guide §2](../docs/integration.md#why-owners-of-the-same-identity-share-a-connection)).
- **The display name is mapped.** Bexio sends `given_name` and `family_name` but no `name`, so `mapProfileToUser` in [`lib/auth.ts`](better-auth/lib/auth.ts) builds Better Auth's `name` from them, with `overrideUserInfo` so it applies on every sign-in.
- **Don't copy `AUTH_RATE_LIMIT=off` to production.** The e2e suite turns Better Auth's sign-in rate limiting off because it signs in many times in a row.

## Supabase

- **Sign in with Bexio needs a live Bexio account.** Supabase Auth only accepts a public HTTPS issuer, so it can't run against the mock; the e2e test covers Connect Bexio.
- **The provider isn't set up in `config.toml`.** Create the custom OIDC provider through the Auth admin API (`supabase.auth.admin.customProviders.createProvider`, or `POST <SUPABASE_URL>/auth/v1/admin/custom-providers` with the secret key; locally `http://127.0.0.1:55621`) with identifier `custom:bexio`, issuer `https://auth.bexio.com/realms/bexio` and scopes `openid profile email company_profile offline_access`. Then set `BEXIO_SUPABASE_PROVIDER=custom:bexio`. `npm run db:reset` deletes the provider; register it again afterwards.
- **Give the app its own Bexio OAuth client**, shared by the custom provider and the library, but not with another app (see [Better Auth](#better-auth)).
- **What Supabase hands over:** `provider_token` and `provider_refresh_token` (with `offline_access`), but no ID token. Bexio's access token carries only ids, so `saveGrant` reads the company name, email and person name from Bexio's userinfo endpoint.
- **The session cookie keeps no Bexio tokens:** [`app/auth/callback/route.ts`](supabase/app/auth/callback/route.ts) re-saves the session without them.
- **Plan limits:** a Supabase Free plan project can add up to 3 custom providers; Pro and above are unlimited ([Supabase docs](https://supabase.com/docs/guides/auth/custom-oauth-providers)). Self-hosted Auth reads `GOTRUE_CUSTOM_OAUTH_MAX_PROVIDERS`.

## Redirect URIs to register at Bexio

| URI                                             | Used by                                                     |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `http://localhost:3400/api/auth/callback/bexio` | Better Auth sign-in (`genericOAuth`, Better Auth 1.7 route) |
| `http://localhost:3400/api/bexio/callback`      | Connect Bexio, Better Auth app                              |
| `http://localhost:3300/api/bexio/callback`      | Connect Bexio, Supabase app                                 |
| `http://127.0.0.1:55621/auth/v1/callback`       | Supabase Auth custom provider (Sign in with Bexio)          |

## Test scenarios with a live Bexio account

Results are production data: keep them out of PRs, issues and comments.

- Sign in, connect, call the API, force a refresh, disconnect.
- Two workspaces, same user and company: one shared connection; both survive refreshes and a disconnect of either.
- Same user, two companies: two connections that refresh independently; revoking either ends both.
- Revoking a stale token ends the current chain.
- Supabase: Sign in with Bexio stores company and user name and a refresh token.
