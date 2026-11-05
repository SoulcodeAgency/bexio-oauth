import { BexioOAuthError } from "./errors.js";

/** The schema, roles and tables are named this unless you choose otherwise. */
export const DEFAULT_SCHEMA = "bexio_oauth";
export const DEFAULT_STORE_ROLE = "bexio_store";
export const DEFAULT_TOKEN_ROLE = "bexio_token";

// Lowercase, so the name means the same quoted or not; at most 63 bytes,
// Postgres's identifier limit. `pg_` is reserved for system schemas and roles.
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Checks a schema or role name the caller passed in, once, before it is ever
 * put into SQL. Throws `invalid_config`.
 */
export function checkName(value: string, option: string): string {
  if (!IDENTIFIER.test(value) || value.startsWith("pg_")) {
    throw new BexioOAuthError(
      "invalid_config",
      `${option} must be a lowercase Postgres identifier (a-z, 0-9, _; at most 63 characters; not starting with a digit or pg_)`,
    );
  }
  return value;
}

/** Schemas the setup's revokes would break, or that aren't the app's to change. */
const SHARED_SCHEMAS = new Set(["public", "information_schema"]);

/** `checkName`, and the schema must be a dedicated one. */
export function checkSchema(value: string): string {
  if (SHARED_SCHEMAS.has(checkName(value, "schema"))) {
    throw new BexioOAuthError(
      "invalid_config",
      `schema must be a dedicated schema, not ${value}`,
    );
  }
  return value;
}

// Postgres reads `public` (even quoted) as PUBLIC, every role, and refuses
// `none`; `current_user` and friends name the session's role. The rest are
// the admin and the API roles of hosted platforms (Supabase), which the
// setup revokes. The SQL also refuses any existing role that isn't a plain
// login role; this catches the common mistakes before any SQL runs.
const RESERVED_ROLES = new Set([
  "public",
  "none",
  "current_user",
  "current_role",
  "session_user",
  "postgres",
  "anon",
  "authenticated",
  "service_role",
  "authenticator",
]);

/** `checkName`, and the role must be a dedicated one. */
export function checkRole(value: string, option: string): string {
  if (RESERVED_ROLES.has(checkName(value, option))) {
    throw new BexioOAuthError(
      "invalid_config",
      `${option} must be a dedicated role, not ${value}`,
    );
  }
  return value;
}

/** A checked name as a quoted identifier. */
export const quoteName = (name: string) => `"${name}"`;
