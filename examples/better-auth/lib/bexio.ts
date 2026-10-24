import {
  createBexioOAuth,
  postgresStore,
  type BexioOAuth,
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
    keys: JSON.parse(env("BEXIO_TOKEN_KEYS")),
    store: postgresStore(getPool()),
    issuer: optionalEnv("BEXIO_ISSUER"),
    apiBaseUrl: optionalEnv("BEXIO_API_BASE_URL"),
  }));
}

/** Owners in this demo: the signed-in user, and two workspaces everyone may manage. */
export const WORKSPACES = ["a", "b"] as const;
export const workspaceOwner = (slug: string) => `workspace:${slug}`;
export const isWorkspaceOwner = (ownerId: string) =>
  WORKSPACES.some((slug) => workspaceOwner(slug) === ownerId);
