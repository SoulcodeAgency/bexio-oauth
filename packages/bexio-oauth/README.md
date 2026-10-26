# @soulcode/bexio-oauth

Bexio OAuth token custody for Node apps. Connect Bexio accounts, store their tokens encrypted in Postgres, and get a valid access token anywhere, including background jobs, without two server instances ever refreshing the same token at once.

It is **not** an auth framework: your app keeps its own login. For "Sign in with Bexio", let your auth framework run the login and hand the tokens over with `saveGrant()`.

- Full guide: [docs/integration.md](https://github.com/SoulcodeAgency/bexio-oauth/blob/main/docs/integration.md)
- Working examples (Better Auth, Supabase Auth): [examples/](https://github.com/SoulcodeAgency/bexio-oauth/tree/main/examples)

## Install

```bash
npm install @soulcode/bexio-oauth pg
npx @soulcode/bexio-oauth sql > migrations/0001_bexio_oauth.sql    # then apply it
npx @soulcode/bexio-oauth keygen                                    # encryption key
```

Requires Node ≥ 24 and PostgreSQL.

Use one Bexio OAuth client per app: Bexio keeps one refresh token chain per user, company and client, so apps sharing a client id invalidate each other's grants. Owners of your app that connect the same Bexio user and company share one connection, refreshed once for all of them ([guide §2](https://github.com/SoulcodeAgency/bexio-oauth/blob/main/docs/integration.md#why-owners-of-the-same-identity-share-a-connection)).

## Quickstart

```ts
// lib/bexio.ts (server-only)
import { Pool } from "pg";
import { createBexioOAuth, postgresStore } from "@soulcode/bexio-oauth";

export const bexio = createBexioOAuth({
  clientId: process.env.BEXIO_CLIENT_ID!,
  clientSecret: process.env.BEXIO_CLIENT_SECRET!,
  redirectUri: process.env.BEXIO_REDIRECT_URI!, // e.g. https://app.example.com/api/bexio/callback
  scopes: ["contact_show"],
  keys: JSON.parse(process.env.BEXIO_TOKEN_KEYS!), // {"current":"k1","keys":{"k1":"<keygen>"}}
  store: postgresStore(
    new Pool({ connectionString: process.env.DATABASE_URL }),
  ),
});
```

```ts
// GET /api/bexio/connect
export const GET = async (req: Request) =>
  bexio.start({
    ownerId: await currentWorkspaceId(req),
    returnTo: "/settings",
  });

// GET /api/bexio/callback  (your redirectUri)
export const GET = async (req: Request) =>
  bexio.callback(req, { ownerId: await currentWorkspaceId(req) });
```

```ts
// anywhere on the server, including cron jobs
const { accessToken } = await bexio.getAccessToken({ ownerId: workspaceId });
await fetch("https://api.bexio.com/2.0/contact", {
  headers: {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  },
});
```

Also: `listGrants`, `disconnect`, `refreshIdle` (keep idle connections alive), `saveGrant` (tokens from your auth framework). Every error is a `BexioOAuthError` with a stable `code`.

## License

MIT
