# Examples

Runnable apps that show `@soulcode/bexio-oauth` inside real auth stacks. They are the recipes behind [docs/integration.md §8](../docs/integration.md#8-sign-in-with-bexio).

| App                                        | Auth                             | Database                              | Shows                                                                                                                                                                  | e2e               |
| ------------------------------------------ | -------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| [`better-auth`](better-auth)               | Better Auth `genericOAuth`       | Plain Postgres (`pg`)                 | **Sign in with Bexio** → `saveGrant`; **Connect Bexio** for workspaces (`authorizeOwner`); a background job; the `refreshIdle` cron; reconnect after `reauth_required` | 7 tests, every PR |
| [`supabase`](supabase)                     | Supabase Auth (email + password) | Local Supabase (`pg` to its Postgres) | **Connect Bexio** for a Supabase user; RLS keeps both tables unreadable through the API; **Sign in with Bexio** through a custom OIDC provider                         | 1 test, every PR  |
| [`_shared/mock-bexio`](_shared/mock-bexio) | –                                | –                                     | A mock of Bexio's Keycloak (PKCE, rotating refresh tokens with reuse detection, one token chain per user and company)                                                  | unit tests        |

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

Both apps can share one Bexio OAuth app. Bexio keeps one token chain per user, company and client, so connecting a user and company in one app ends that chain in the other: reconnect after switching apps.

## Better Auth

**Don't copy `AUTH_RATE_LIMIT=off` to production.** The e2e suite turns Better Auth's sign-in rate limiting off because it signs in many times in a row.

## Supabase

- **The provider isn't set up in `config.toml`.** Create the custom OIDC provider through the Auth admin API (`supabase.auth.admin.customProviders.createProvider`, or `POST <SUPABASE_URL>/auth/v1/admin/custom-providers` with the secret key; locally `http://127.0.0.1:55621`) with identifier `custom:bexio`, issuer `https://auth.bexio.com/realms/bexio` and scopes `openid profile email company_profile offline_access`. Then set `BEXIO_SUPABASE_PROVIDER=custom:bexio`. `npm run db:reset` deletes the provider; register it again afterwards.

## Redirect URIs to register at Bexio

| URI                                             | Used by                                                     |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `http://localhost:3400/api/auth/callback/bexio` | Better Auth sign-in (`genericOAuth`, Better Auth 1.7 route) |
| `http://localhost:3400/api/bexio/callback`      | Connect Bexio, Better Auth app                              |
| `http://localhost:3300/api/bexio/callback`      | Connect Bexio, Supabase app                                 |
| `http://127.0.0.1:55621/auth/v1/callback`       | Supabase Auth custom provider (Sign in with Bexio)          |

## Test scenarios with a live Bexio account

- Sign in, connect, call the API, force a refresh, disconnect.
- Two workspaces, same user and company: one shared connection; both survive refreshes and a disconnect of either.
- Same user, two companies: two connections that refresh independently; revoking either ends both.
- Revoking a stale token ends the current chain.
- Supabase: Sign in with Bexio stores company and user name and a refresh token.
