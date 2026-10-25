# Examples

Runnable apps that show `@soulcode/bexio-oauth` inside real auth stacks. They are the recipes behind [docs/integration.md §8](../docs/integration.md#8-sign-in-with-bexio) and carry the end-to-end tests. None of this is published.

| App                                        | Auth                             | Database                              | Shows                                                                                                                                                                                                      | e2e               |
| ------------------------------------------ | -------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| [`better-auth`](better-auth)               | Better Auth `genericOAuth`       | Plain Postgres (`pg`)                 | **Sign in with Bexio** → `saveGrant`; **Connect Bexio** for workspaces (`authorizeOwner`); a background job; the `refreshIdle` cron; reconnect after `reauth_required`; two owners sharing a Bexio account | 6 tests, every PR |
| [`supabase`](supabase)                     | Supabase Auth (email + password) | Local Supabase (`pg` to its Postgres) | **Connect Bexio** for a Supabase user; RLS keeps `bexio_grants` unreadable through the API; the **Sign in with Bexio** recipe (alpha, see [Supabase](#supabase))                                           | 1 test, every PR  |
| [`_shared/mock-bexio`](_shared/mock-bexio) | –                                | –                                     | A mock of Bexio's Keycloak (PKCE, rotating refresh tokens with reuse detection, Bexio's claim split) and `/3.0/permissions`                                                                                | unit tests        |

## Running them

```bash
npm ci && npm run build                      # from the repo root: builds the library
cd examples/better-auth
cp .env.example .env.local                   # then fill in BEXIO_TOKEN_KEYS (npx @soulcode/bexio-oauth keygen)
MOCK_BEXIO_PORT=9401 node ../_shared/mock-bexio/src/server.ts   # in a second terminal (9402 for the Supabase app)
npm run migrate && npm run dev               # http://localhost:3400
```

The Supabase example needs Docker: `npm run db:start` in `examples/supabase` starts the local stack and applies `supabase/migrations/` (generated with `npx @soulcode/bexio-oauth sql`, plus `ENABLE ROW LEVEL SECURITY`).

`npm run test:e2e` in either app starts the mock and the app itself (Playwright `webServer`). If a dev server already holds the Better Auth ports, run it with `E2E_APP_PORT=3410 E2E_MOCK_PORT=9411`.

## Better Auth

- **Don't copy `AUTH_RATE_LIMIT=off` to production.** The e2e suite turns Better Auth's sign-in rate limiting off because it signs in many times in a row. Leave the variable unset in real deployments; rate limiting then stays on.

## Supabase

> **Alpha.** "Sign in with Bexio" through Supabase Auth needs validation against a production Bexio account before you rely on it. "Connect Bexio" for Supabase users is not affected; it is covered by the e2e test.

- **The provider isn't set up in `config.toml`.** Create the custom OIDC provider through the Auth admin API (`supabase.auth.admin.customProviders.createProvider`) with issuer `https://auth.bexio.com/realms/bexio` and scopes `openid profile email company_profile offline_access`. Then set `BEXIO_SUPABASE_PROVIDER=custom:bexio`.
- **There is no automated test for it.** Supabase Auth only accepts a public HTTPS issuer, so it can't run against the local mock.
- **Open questions for the validation:**
  - Does Supabase return `provider_refresh_token` for a custom OIDC provider?
  - Does it pass the `offline_access` and `company_profile` scopes through?
  - Do plan limits apply to custom providers?

## Redirect URIs to register at Bexio

| URI                                             | Used by                                                     |
| ----------------------------------------------- | ----------------------------------------------------------- |
| `http://localhost:3400/api/auth/callback/bexio` | Better Auth sign-in (`genericOAuth`, Better Auth 1.7 route) |
| `http://localhost:3400/api/bexio/callback`      | Connect Bexio, Better Auth app                              |
| `http://localhost:3300/api/bexio/callback`      | Connect Bexio, Supabase app                                 |
| `<SUPABASE_URL>/auth/v1/callback`               | Supabase Auth custom provider (Sign in with Bexio)          |

## Manual live-Bexio checklist

Run once per release candidate, in both apps, with a real Bexio OAuth app (`.env.local` without `BEXIO_ISSUER` / `BEXIO_API_BASE_URL`). Record the results in the release PR.

- [ ] Sign in with Bexio (Better Auth) / Connect Bexio (both): the grant shows the right company and role.
- [ ] The sample API call succeeds.
- [ ] Forced refresh: set the grant's `access_expires_at` to the past in the database, reload; the call still succeeds and `last_refreshed_at` moves.
- [ ] Disconnect: the grant disappears, and the refresh token no longer works at Bexio.
- [ ] Two owners: connect the same Bexio user and company for workspace a and b, disconnect a, then force a refresh of b. It must still work. (Keycloak's revocation has been known to end all of a user's offline sessions for a client; if it does, the library must stop revoking on disconnect.)
- [ ] Supabase only: Sign in with Bexio through the custom provider (answers the open questions in [Supabase](#supabase)).
