# Examples

Runnable apps that show `@soulcode/bexio-oauth` inside real auth stacks. They are the recipes behind [docs/integration.md §8](../docs/integration.md#8-sign-in-with-bexio) and carry the end-to-end tests. None of this is published.

| App                                        | Auth                             | Database                              | Shows                                                                                                                                                                                                      | e2e               |
| ------------------------------------------ | -------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| [`better-auth`](better-auth)               | Better Auth `genericOAuth`       | Plain Postgres (`pg`)                 | **Sign in with Bexio** → `saveGrant`; **Connect Bexio** for workspaces (`authorizeOwner`); a background job; the `refreshIdle` cron; reconnect after `reauth_required`; two owners sharing a Bexio account | 5 tests, every PR |
| [`supabase`](supabase)                     | Supabase Auth (email + password) | Local Supabase (`pg` to its Postgres) | **Connect Bexio** for a Supabase user; RLS keeps `bexio_grants` unreadable through the API; the **Sign in with Bexio** recipe (manual check only, see below)                                               | 1 test, every PR  |
| [`_shared/mock-bexio`](_shared/mock-bexio) | –                                | –                                     | A mock of Bexio's Keycloak (PKCE, rotating refresh tokens with reuse detection, Bexio's claim split) and `/3.0/permissions`                                                                                | unit tests        |

## Running them

```bash
npm ci && npm run build                      # from the repo root: builds the library
cd examples/better-auth
cp .env.example .env.local                   # then fill in BEXIO_TOKEN_KEYS (npx @soulcode/bexio-oauth keygen)
node ../_shared/mock-bexio/src/server.ts     # in a second terminal: MOCK_BEXIO_PORT=9401
npm run migrate && npm run dev               # http://localhost:3400
```

The Supabase example needs Docker: `npm run db:start` in `examples/supabase` starts the local stack and applies `supabase/migrations/` (generated with `npx @soulcode/bexio-oauth sql`, plus `ENABLE ROW LEVEL SECURITY`).

`npm run test:e2e` in either app starts the mock and the app itself (Playwright `webServer`).

## Findings: can the auth framework hand over Bexio's tokens?

**Better Auth (`genericOAuth`): yes, tested.** Better Auth writes the provider tokens, including the refresh token, to its `account` row during the callback. An `after` hook passes them to `saveGrant()` as soon as a session exists and then clears Better Auth's copy, so the grant is the only place they live (asserted in e2e). Two details:

- The account `update` hook doesn't receive the user id on a repeat sign-in, so the hand-over happens in `hooks.after`, not in `databaseHooks`.
- Better Auth rate-limits sign-ins in production; the e2e suite turns that off (`AUTH_RATE_LIMIT=off`).

**Supabase Auth (custom OIDC provider): can't be tested against a mock; check manually with live Bexio.**

- Custom providers are created through the Auth admin API (`POST /auth/v1/admin/custom-providers`, or `supabase.auth.admin.customProviders.createProvider`). The Supabase CLI has no `config.toml` option for them.
- Supabase Auth only accepts an **HTTPS** issuer (`URL must use HTTPS`) and refuses issuers on **private network addresses** (`URL cannot resolve to private network addresses`). A local mock can't satisfy that, even with a trusted certificate, so this path has no automated test.
- The recipe is implemented in [`supabase/app/auth/callback/route.ts`](supabase/app/auth/callback/route.ts): `exchangeCodeForSession()` returns `provider_token` and `provider_refresh_token` once, and they go straight to `saveGrant()`. Enable it with `BEXIO_SUPABASE_PROVIDER=custom:bexio` after registering the provider against `https://auth.bexio.com/realms/bexio` with the scopes `openid profile email company_profile offline_access`.
- **Still to verify with live Bexio:**
  - Does Supabase return `provider_refresh_token` for a custom OIDC provider?
  - Does it pass `offline_access` and `company_profile` through?
  - Do plan limits apply?

## Manual live-Bexio checklist

Run once per release candidate, in both apps, with a real Bexio OAuth app (`.env.local` without `BEXIO_ISSUER` / `BEXIO_API_BASE_URL`). Record the results in the release PR.

- [ ] Sign in with Bexio (Better Auth) / Connect Bexio (both): the grant shows the right company and role.
- [ ] The sample API call succeeds.
- [ ] Forced refresh: set the grant's `access_expires_at` to the past in the database, reload; the call still succeeds and `last_refreshed_at` moves.
- [ ] Disconnect: the grant disappears, and the refresh token no longer works at Bexio.
- [ ] Supabase only: Sign in with Bexio through the custom provider (answers the open questions above).
