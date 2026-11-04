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

/** A checked name as a quoted identifier. */
export const quoteName = (name: string) => `"${name}"`;
