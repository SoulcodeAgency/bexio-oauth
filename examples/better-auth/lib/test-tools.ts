import { BEXIO_ISSUER } from "@soulcode/bexio-oauth";
import { compactDecrypt } from "jose";
import { getPool } from "./db";
import { env, optionalEnv } from "./env";

/**
 * Test tools for live Bexio accounts (examples/README.md): expire a
 * connection's access token, and revoke its refresh token at Bexio without
 * disconnecting (now, or later, once a reconnect has made it stale).
 *
 * They read the library's table and decrypt a refresh token, which a real app
 * never does: the library keeps tokens to itself on purpose. Only on with
 * BEXIO_TEST_TOOLS=on; never enable them in production.
 */
export const testToolsEnabled = () => process.env.BEXIO_TEST_TOOLS === "on";

/**
 * Encrypted refresh tokens saved for a later revoke, by connection id. On
 * globalThis, so `next dev` reloading this module keeps them.
 */
const holder = globalThis as { bexioSavedTokens?: Map<string, string> };
const saved = (holder.bexioSavedTokens ??= new Map<string, string>());

export const hasSavedToken = (connectionId: string) => saved.has(connectionId);

async function encryptedRefreshToken(connectionId: string): Promise<string> {
  const { rows } = await getPool().query<{ refresh_token: string | null }>(
    "SELECT refresh_token FROM bexio_connections WHERE id = $1",
    [connectionId],
  );
  const token = rows[0]?.refresh_token;
  if (!token) throw new Error("connection has no refresh token");
  return token;
}

async function decrypt(jwe: string): Promise<string> {
  const keyring = JSON.parse(env("BEXIO_TOKEN_KEYS")) as {
    keys: Record<string, string>;
  };
  const { plaintext } = await compactDecrypt(jwe, (header) => {
    const key = header.kid && keyring.keys[header.kid];
    if (!key) throw new Error("unknown key id");
    return Buffer.from(key, "base64url");
  });
  return new TextDecoder().decode(plaintext);
}

async function revoke(jwe: string): Promise<void> {
  const issuer = optionalEnv("BEXIO_ISSUER") ?? BEXIO_ISSUER;
  const discovery = await fetch(`${issuer}/.well-known/openid-configuration`);
  const { revocation_endpoint } = (await discovery.json()) as {
    revocation_endpoint?: string;
  };
  if (!revocation_endpoint)
    throw new Error("issuer has no revocation endpoint");
  const res = await fetch(revocation_endpoint, {
    method: "POST",
    body: new URLSearchParams({
      client_id: env("BEXIO_CLIENT_ID"),
      client_secret: env("BEXIO_CLIENT_SECRET"),
      token: await decrypt(jwe),
      token_type_hint: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`revocation failed: HTTP ${res.status}`);
}

/** The next getAccessToken refreshes: a forced refresh. */
export async function expireAccessToken(connectionId: string): Promise<void> {
  await getPool().query(
    "UPDATE bexio_connections SET access_expires_at = now() - interval '1 minute' WHERE id = $1",
    [connectionId],
  );
}

export async function revokeCurrentToken(connectionId: string): Promise<void> {
  await revoke(await encryptedRefreshToken(connectionId));
}

/** Keeps the current refresh token; reconnect, and it becomes stale. */
export async function saveToken(connectionId: string): Promise<void> {
  saved.set(connectionId, await encryptedRefreshToken(connectionId));
}

export async function revokeSavedToken(connectionId: string): Promise<void> {
  const jwe = saved.get(connectionId);
  if (!jwe) throw new Error("no saved token for this connection");
  saved.delete(connectionId);
  await revoke(jwe);
}
