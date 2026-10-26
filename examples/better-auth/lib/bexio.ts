import {
  createBexioOAuth,
  postgresStore,
  type BexioOAuth,
  type Keyring,
} from "@soulcode/bexio-oauth";
import { getPool } from "./db";
import { env, optionalEnv } from "./env";

let bexio: BexioOAuth | undefined;

export function getBexio(): BexioOAuth {
  return (bexio ??= createBexioOAuth({
    clientId: env("BEXIO_CLIENT_ID"),
    clientSecret: env("BEXIO_CLIENT_SECRET"),
    redirectUri: `${env("APP_URL")}/api/bexio/callback`,
    scopes: (process.env.BEXIO_SCOPES ?? "").split(" ").filter(Boolean),
    keys: JSON.parse(env("BEXIO_TOKEN_KEYS")) as Keyring,
    store: postgresStore(getPool()),
    issuer: optionalEnv("BEXIO_ISSUER"),
    apiBaseUrl: optionalEnv("BEXIO_API_BASE_URL"),
  }));
}

/** The demo's workspaces; owner ids are `workspace:<slug>`. */
export const WORKSPACES = ["a", "b"] as const;
export const workspaceOwner = (slug: string) => `workspace:${slug}`;

/**
 * May this user connect / disconnect Bexio for this owner? The one place the
 * demo decides it; connect, callback and disconnect all go through here.
 * A user always manages their own grant. In this demo every signed-in user
 * may manage both workspaces. A real app checks workspace membership and role
 * here.
 */
export function canManageOwner(
  user: { id: string } | null | undefined,
  ownerId: string,
): boolean {
  if (!user) return false;
  if (ownerId === user.id) return true;
  return WORKSPACES.some((slug) => workspaceOwner(slug) === ownerId);
}
