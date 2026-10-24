# `@soulcode/bexio-oauth`: integration guide

> **Status: draft spec for v0.1.** This document is written before the code and describes the intended API. Names may still change during implementation; once v0.1 ships, this file becomes the reference.

This guide is for developers and coding agents integrating Bexio OAuth into an app. It explains the concepts, every public function, the database setup, the security model and the reasoning behind the design. The [README](../README.md) is the short version.

---

## 1. What this library does, and what it doesn't

**It holds and refreshes Bexio OAuth tokens for your app ("token custody").** Bexio uses OpenID Connect (Keycloak). After a user authorizes your app, you get an access token (short-lived) and a refresh token (long-lived, rotates on every use). This library:

- runs the **"Connect Bexio" flow**: redirect to Bexio, handle the callback, store the result;
- stores tokens **encrypted** in your Postgres database;
- hands out a **valid access token** on demand and refreshes it when needed. This works from request handlers and from background jobs alike, and stays safe when many server instances refresh at once;
- tells you **who** connected (Bexio user, company, admin or member).

**It does not manage users, sessions or login.** That's your auth framework's job (Supabase Auth, Better Auth, Auth.js, …). If you want "Sign in with Bexio", your auth framework runs the login, and you hand the resulting tokens to this library with `saveGrant()`. See [§8](#8-sign-in-with-bexio).

**It is not a Bexio API client.** It gives you an access token; call the Bexio API with `fetch` or the client of your choice.

## 2. Concepts

### Grant

A **grant** is one Bexio authorization stored by the library: the tokens, plus who granted them. Bexio issues tokens per **(Bexio user, Bexio company)** pair. A user with access to three companies who connects all three has three grants.

### Owner

Every grant belongs to an **owner**, an opaque string **your app** chooses: a user id, a workspace id, a tenant id. The library never interprets it.

A grant is unique per **(owner, Bexio company, Bexio user)**:

- Reconnecting the same Bexio user and company for the same owner **replaces** the tokens on that grant.
- Two owners may connect the same Bexio user and company. They get **separate** grants, so disconnecting one never affects the other.

| Your app's model | Typical `ownerId` |
|---|---|
| Each user connects their own Bexio | the user's id |
| A workspace connects Bexio once, everyone in it uses it | the workspace id |
| "Sign in with Bexio" | the user's id in your auth framework |

### Role

Each grant records the Bexio user's **role** in that company: `admin` or `member`. It is read from Bexio's `/3.0/permissions` when the grant is created and on every token refresh. Use it to gate admin features without an extra API call.

### Status

`active`, or `reauth_required` when Bexio rejected the refresh token (the user revoked access, the session idled out, or the password was reset). A `reauth_required` grant stays in the table so your UI can show "reconnect", until it is reconnected or disconnected.

## 3. Requirements and install

- Node.js ≥ 24, ESM.
- PostgreSQL (any host: self-hosted, Supabase, or another managed Postgres) reached through a driver that matches [`SqlClient`](#sqlclient).
- A Bexio OAuth app (client id and secret) from the Bexio developer portal, with your callback URL registered as a redirect URI.

```bash
npm install @soulcode/bexio-oauth pg
```

Runtime dependencies: [`openid-client`](https://github.com/panva/openid-client) and [`jose`](https://github.com/panva/jose). Nothing else.

## 4. Database setup

The library uses **one table, `bexio_grants`**. You create it with your own migration tool. The library never runs migrations itself.

### The CLI

The package ships its schema as numbered SQL files and a small command that prints them:

```bash
npx @soulcode/bexio-oauth sql              # all migrations, in order
npx @soulcode/bexio-oauth sql --from 2     # only migrations 0002 onwards (for upgrades)
npx @soulcode/bexio-oauth keygen           # a new random 32-byte encryption key (base64url)
```

What it is for:

- **The SQL always matches the version you installed.** Copying SQL from a README or a blog post can give you a schema for a different version. The CLI reads the files bundled in *your* `node_modules`.
- **It plugs into any migration tool.** It only writes to stdout, so you redirect it into a new migration file and your tool takes it from there:

  ```bash
  # Supabase CLI
  npx @soulcode/bexio-oauth sql > supabase/migrations/20261024120000_bexio_grants.sql
  # Plain SQL migrations (dbmate, node-pg-migrate in SQL mode, Flyway, …)
  npx @soulcode/bexio-oauth sql > db/migrations/20261024120000_bexio_grants.sql
  # Or apply directly
  npx @soulcode/bexio-oauth sql | psql "$DATABASE_URL"
  ```

- **Upgrades are explicit.** When a new version adds a migration, the changelog says so, and `sql --from <n>` prints just the new part for your next migration file.
- **`keygen`** saves you from hand-rolling a random key (see [§5](#encryption-keys)).

The SQL files are also in the package at `node_modules/@soulcode/bexio-oauth/sql/` if you'd rather copy them by hand. The CLI is a convenience, not a requirement.

### Supabase

Connect through the pooler connection string (Project settings → Database), not supabase-js: the library needs real SQL for its atomic refresh lock. Then **enable row-level security on `bexio_grants` and add no policies**. The `anon` and `authenticated` roles then can't read it, and only your server-side connection can.

```sql
alter table public.bexio_grants enable row level security;
```

### `SqlClient`

The store needs a single method:

```ts
interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}
```

A `pg` `Pool` or `Client` matches this as is. For other drivers, write a few lines of wrapper:

```ts
// postgres.js
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL!);
const client = { query: async (text, params = []) => ({ rows: await sql.unsafe(text, params) }) };
```

Every store operation is **one SQL statement**, so the library works with transaction-mode poolers and HTTP-based drivers.

## 5. Configuration

```ts
// lib/bexio.ts (server-only)
import { Pool } from "pg";
import { createBexioOAuth, postgresStore } from "@soulcode/bexio-oauth";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const bexio = createBexioOAuth({
  clientId: process.env.BEXIO_CLIENT_ID!,
  clientSecret: process.env.BEXIO_CLIENT_SECRET!,
  redirectUri: process.env.BEXIO_REDIRECT_URI!, // e.g. https://app.example.com/api/bexio/callback
  scopes: ["accounting", "contact_show"],       // the Bexio API scopes your app needs
  keys: JSON.parse(process.env.BEXIO_TOKEN_KEYS!), // { "current": "k1", "keys": { "k1": "<base64url>" } }
  store: postgresStore(pool),
});
```

| Option | Required | Notes |
|---|---|---|
| `clientId`, `clientSecret` | yes | From your Bexio OAuth app. |
| `redirectUri` | yes | Must exactly match a redirect URI registered at Bexio. |
| `scopes` | no | Bexio API scopes. Always added: `openid profile email company_profile offline_access`. `offline_access` is what makes background refresh possible. |
| `keys` | yes | Encryption keyring, see below. |
| `store` | yes | `postgresStore(sqlClient)` or `memoryStore()` (tests only). |
| `issuer`, `apiBaseUrl` | no | Default to Bexio's production URLs. Override only to point at a mock in tests. |
| `refreshLockTtl` | no | Default 30 s. See [§10](#refresh-coordination). |

The library **never reads environment variables itself**. You pass everything in, so it's obvious what it uses and it works in any runtime.

### Encryption keys

Tokens are encrypted with a key from your keyring. Generate a key:

```bash
npx @soulcode/bexio-oauth keygen
```

and store the keyring as one env var:

```bash
BEXIO_TOKEN_KEYS='{"current":"k1","keys":{"k1":"<output of keygen>"}}'
```

**Rotating a key:** add a new key and point `current` at it, keeping the old one:

```bash
BEXIO_TOKEN_KEYS='{"current":"k2","keys":{"k1":"…","k2":"…"}}'
```

New writes use `k2`; rows encrypted with `k1` still decrypt. Every refresh re-encrypts with the current key, and every active grant is refreshed at least once per `refreshIdle` window (see [§9](#9-background-jobs)). So once one `idleFor` period has passed, only `reauth_required` grants still use `k1`. Remove `k1` after those are reconnected or disconnected.

## 6. Connect Bexio

Two route handlers. Both take and return web-standard `Request`/`Response`, so they work as Next.js route handlers as-is and in any framework that speaks Fetch API.

```ts
// app/api/bexio/connect/route.ts
import { bexio } from "@/lib/bexio";
import { requireWorkspace } from "@/lib/auth"; // your app's auth

export async function GET(request: Request) {
  const workspace = await requireWorkspace(request);
  return bexio.start(request, { ownerId: workspace.id, returnTo: "/settings/bexio" });
}
```

```ts
// app/api/bexio/callback/route.ts  ← this URL is your redirectUri
import { bexio } from "@/lib/bexio";
import { requireWorkspace } from "@/lib/auth";

export async function GET(request: Request) {
  const workspace = await requireWorkspace(request);
  return bexio.callback(request, { ownerId: workspace.id });
}
```

What happens:

1. `start` creates a random `state`, a PKCE verifier and a `nonce`, stores them with `ownerId` and `returnTo` in an **encrypted, HttpOnly cookie** (10 minutes, scoped to the callback path), and redirects to Bexio.
2. The user logs in at Bexio, picks a company and consents.
3. `callback` reads the cookie, checks `state`, **checks that the `ownerId` you pass now equals the one from `start`**, exchanges the code (PKCE), verifies the ID token (signature, issuer, audience, nonce), reads the user's role, saves the grant, deletes the cookie, and redirects to `returnTo`.
4. On failure it redirects to `returnTo?bexio_error=<code>` (see [§11](#11-errors)) and saves nothing.

Why the `ownerId` check matters: without it, an attacker could start a flow for their own workspace, trick a victim into finishing it, and attach the victim's Bexio account to the attacker's workspace (connection CSRF). Always derive `ownerId` from your authenticated session, never from the query string.

Need the grant itself instead of a redirect (for example in an API)? Use `bexio.handleCallback(request, { ownerId })`, which returns `{ grant, returnTo }` or throws a `BexioOAuthError`.

## 7. Using the token

```ts
const { accessToken } = await bexio.getAccessToken({ ownerId: workspace.id });

const res = await fetch("https://api.bexio.com/2.0/contact", {
  headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
});
```

- If the stored access token is still valid (with a safety margin), it is returned without any network call.
- If it expired, the library refreshes it, stores the new **rotated** refresh token, and returns the new access token.
- An owner with several grants (several companies) must say which: `getAccessToken({ ownerId, companyId })`. Without `companyId` you get `ambiguous_grant`.
- List an owner's grants (no token material) for a "connected companies" screen:

```ts
const grants = await bexio.listGrants({ ownerId: workspace.id });
// [{ id, companyId, companyName, userName, userEmail, companyUserId, role, status, createdAt, … }]
```

Don't cache access tokens yourself. `getAccessToken` is cheap when the token is valid (one indexed `SELECT`), and the library has to see every refresh to keep the rotation consistent.

## 8. Sign in with Bexio

Let your auth framework run the login with Bexio as an OIDC provider (issuer `https://auth.bexio.com/realms/bexio`, scopes including `offline_access` and `company_profile`). In its callback, pass the provider's tokens to the library:

```ts
await bexio.saveGrant({
  ownerId: user.id, // your auth framework's user id
  tokens: { accessToken, refreshToken, idToken, expiresAt },
});
```

`saveGrant` verifies the tokens' signatures against Bexio's published keys before trusting any claim, then saves the grant exactly like `callback` would. From then on, use `getAccessToken({ ownerId: user.id })` as usual.

Working, tested setups live in [`examples/`](../examples):

| Example | Auth framework | Notes |
|---|---|---|
| [`examples/better-auth`](../examples/better-auth) | Better Auth (`genericOAuth`, built-in Postgres) | Also shows the Connect flow, a background job and the `refreshIdle` cron. |
| [`examples/supabase`](../examples/supabase) | Supabase Auth with a custom OIDC provider | Also shows RLS on `bexio_grants`. |

> Whether each framework passes the Bexio **refresh token** to your callback is being verified (see the examples ticket); this table will state the result.

Keep your auth framework from storing its own copy of the Bexio tokens where it can (the examples show how), so the library is the only place they live.

## 9. Background jobs

`getAccessToken` needs no request or session, only the `ownerId`, so you call it the same way from a cron, a queue worker or a script:

```ts
// a scheduled sync job in your app
for (const workspace of await listWorkspacesWithBexio()) {
  try {
    const { accessToken } = await bexio.getAccessToken({ ownerId: workspace.id });
    await syncContacts(accessToken);
  } catch (err) {
    if (err instanceof BexioOAuthError && err.code === "reauth_required") {
      await notifyWorkspaceAdmins(workspace.id); // ask them to reconnect
      continue;
    }
    throw err;
  }
}
```

**Keep idle grants alive.** Bexio ends an offline session if its refresh token goes unused for too long. `refreshIdle` refreshes every active grant whose last refresh is older than `idleFor`. Run it on a schedule, with `idleFor` well inside Bexio's idle timeout:

```ts
// app/api/cron/bexio-refresh/route.ts, run e.g. weekly
export async function GET() {
  const result = await bexio.refreshIdle({ idleFor: "7d" });
  return Response.json(result); // { refreshed: 12, skipped: 40, reauthRequired: 1 }
}
```

Protect that route the way your platform protects cron routes (a secret header, for example).

## 10. Disconnect and re-authorization

```ts
await bexio.disconnect({ ownerId: workspace.id, companyId });
```

This revokes the refresh token at Bexio (when Bexio's discovery document advertises a revocation endpoint) and deletes the grant.

When a refresh fails with `invalid_grant`, the grant is marked `reauth_required` and `getAccessToken` throws `reauth_required`, without contacting Bexio again on later calls. Send the user through the Connect flow again (§6): the same owner, company and user overwrites the grant and sets it back to `active`.

### Refresh coordination

Bexio rotates refresh tokens and rejects a refresh token that has already been used. If two server instances refreshed the same grant at once, the second would fail and could kill the session. The library prevents this with a lock stored in the row:

1. The caller that needs a refresh runs one atomic `UPDATE … SET refresh_locked_until = now() + ttl WHERE … AND (refresh_locked_until IS NULL OR refresh_locked_until < now()) RETURNING …`. Only one caller wins.
2. The winner refreshes, stores the new tokens and clears the lock.
3. The others wait briefly, re-read the row, and use the winner's new token.
4. If the winner crashes, the lock expires after `refreshLockTtl` and the next caller takes over.

This works across processes, containers and serverless instances. All it relies on is the database.

## 11. Errors

All errors are `BexioOAuthError` with a `code`. Token values never appear in messages.

| `code` | Where | Meaning, and what to do |
|---|---|---|
| `state_mismatch` | callback | Cookie missing, expired, or `state` doesn't match. Usually a stale tab or a flow older than 10 min: start again. |
| `owner_mismatch` | callback | The `ownerId` at callback differs from `start`. Possible CSRF; don't retry automatically. |
| `access_denied` | callback | The user cancelled at Bexio. |
| `invalid_callback` | callback, saveGrant | Bad code, nonce or token signature, or the wrong issuer. |
| `idp_error` | any | Bexio returned an unexpected error or was unreachable. Retry later. |
| `not_connected` | getAccessToken | The owner has no grant (for that company). |
| `ambiguous_grant` | getAccessToken | The owner has several grants; pass `companyId`. |
| `reauth_required` | getAccessToken | The refresh token is dead; reconnect via §6. |

## 12. Security model

- **What is stored:** the access and refresh tokens (encrypted), Bexio user and company ids, display names and email, role, status and timestamps. **No ID token**: its claims are read once at connect time and it isn't needed afterwards.
- **Encryption:** each token is a compact JWE (`alg: dir`, `enc: A256GCM`) produced by `jose`, with the key id (`kid`) in the header. The grant's id is part of the authenticated header and checked on decrypt, so ciphertext copied into another row fails to decrypt.
- **Keys** live in your config, never in the database. Anyone holding both a database dump and the keyring can read the tokens; keep them apart.
- **The OIDC protocol** is handled by `openid-client` (OpenID Certified relying-party library): PKCE S256, state, nonce, ID-token signature, issuer and audience checks.
- **The flow cookie** is encrypted (JWE), HttpOnly, Secure, SameSite=Lax, path-scoped, 10 minutes, deleted on use.
- **Database access:** only your server needs it. On Supabase, enable RLS on `bexio_grants` without policies (§4).
- **Permissions:** an access token acts with the connecting Bexio user's rights in that company. If that user leaves the company or loses rights, calls start failing, and a different user has to reconnect.

## 13. Data model

`bexio_grants` (simplified; the SQL files are authoritative):

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | Also bound into the encryption. |
| `owner_id` | `text` | Your opaque owner. |
| `bexio_company_id` | `text` | Bexio's `company_id` claim. |
| `bexio_user_id` | `text` | OIDC `sub`. |
| `bexio_company_user_id` | `integer` | The user's id inside the company (Bexio's API uses it, e.g. for timesheets). |
| `company_name`, `user_name`, `user_email` | `text` | For display; refreshed on connect. |
| `role` | `text` | `admin` \| `member`. |
| `status` | `text` | `active` \| `reauth_required`. |
| `access_token`, `refresh_token` | `text` | JWE compact strings. |
| `access_expires_at`, `refresh_expires_at` | `timestamptz` | |
| `scope` | `text` | Scopes actually granted. |
| `refresh_locked_until` | `timestamptz` | Refresh lock (§10). |
| `last_refreshed_at`, `created_at`, `updated_at` | `timestamptz` | `last_refreshed_at` drives `refreshIdle`, so `getAccessToken` stays read-only when the token is valid. |

Unique: `(owner_id, bexio_company_id, bexio_user_id)`. Index on `owner_id`.

Need to reference a grant from your own tables? Store the `owner_id` you chose (you already have it), or the grant `id` when you need a specific company. Foreign keys into `bexio_grants` are fine; the library never deletes rows except through `disconnect`.

## 14. Testing your app

- Use `memoryStore()` in unit tests: same behavior, no database.
- For end-to-end tests, point `issuer` and `apiBaseUrl` at a mock OIDC server that issues Bexio-shaped tokens. The repo's `examples/_shared/mock-bexio` is a reference you can copy (it isn't published).

## 15. Design notes

Why the library looks the way it does. If any of these change, the reasoning is recorded as an ADR in `docs/adr/`.

- **Token custody, not an auth framework.** Most apps that need Bexio already have login. Bundling an auth framework would force a second auth system on them, and session management is a solved problem. Apps that log in *with* Bexio use their own framework plus `saveGrant()`.
- **One table.** A grant already holds company, user and role, so it doubles as the membership record. There are no separate company or member tables to keep in sync. Apps that need their own tenant table own it.
- **Opaque `ownerId`.** It fits any tenancy model. Uniqueness per owner keeps disconnects local, even when two owners connect the same Bexio account.
- **Plain Postgres, no ORM.** One table doesn't justify an ORM's dependency and migration workflow, which would compete with the app's own. Single-statement operations keep the lock atomic and work through any driver or pooler.
- **No custom protocol or crypto code.** `openid-client` and `jose` cover OIDC and encryption; what's left is storage, refresh coordination and Bexio specifics.
- **No env reads inside the library.** Explicit config is easier to test and to reason about, and works the same in every runtime.
