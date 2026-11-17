import { BexioOAuthError } from "./errors.js";
import { MIGRATIONS } from "./migrations.generated.js";
import {
  DEFAULT_SCHEMA,
  DEFAULT_STORE_ROLE,
  DEFAULT_TOKEN_ROLE,
  checkRole,
  checkSchema,
  quoteName,
} from "./names.js";

export interface Migration {
  /** Sequence number, from the file name prefix (`0001_…` → 1). */
  number: number;
  name: string;
  sql: string;
}

/** Names for the SQL that `migrations()` returns. */
export interface MigrationOptions {
  /** Schema for the tables. Default `bexio_oauth`. Pass the same to `postgresStore`. */
  schema?: string;
  /** Login role for `postgresStore`'s connection: full access to the tables. Default `bexio_store`. */
  storeRole?: string;
  /**
   * Also create this narrower login role, for runtimes that only use tokens
   * (`getAccessToken`, `listGrants`, `refreshIdle`). Not created unless set;
   * the conventional name is `bexio_token`.
   */
  tokenRole?: string;
}

/** A migration as written in `sql/`, with the default names. */
export interface MigrationSource extends Migration {
  /** The matching `NNNN_*.token-role.sql`, if this migration has one. */
  tokenRoleSql?: string;
}

type DefaultName =
  typeof DEFAULT_SCHEMA | typeof DEFAULT_STORE_ROLE | typeof DEFAULT_TOKEN_ROLE;

// The default names, as string literals (e.g. role lookups in pg_roles) and
// as identifiers. One pass, so a replacement is never replaced again.
const DEFAULTS = [DEFAULT_SCHEMA, DEFAULT_STORE_ROLE, DEFAULT_TOKEN_ROLE].join(
  "|",
);
const NAMES = new RegExp(`'(${DEFAULTS})'|\\b(${DEFAULTS})\\b`, "g");

/**
 * Replaces the default names in `sql` with `names` (keyed by default name).
 * Names must be checked identifiers: then they are safe both quoted and
 * inside a string literal. Unchanged names stay as written, so the output
 * with the defaults equals sql/.
 */
export function renameDefaults(
  sql: string,
  names: Record<DefaultName, string>,
): string {
  return sql.replace(NAMES, (match, literal?: string, identifier?: string) => {
    if (literal) return `'${names[literal as DefaultName]}'`;
    const name = names[identifier as DefaultName];
    return name === identifier ? match : quoteName(name);
  });
}

/**
 * The schema migrations shipped with this version, in order, for your
 * schema and role names.
 *
 * The SQL is embedded in the build (generated from `sql/*.sql`), not read from
 * disk, so this works unchanged when a bundler inlines the library. Invalid
 * names throw `invalid_config`.
 */
export async function migrations(
  options: MigrationOptions = {},
): Promise<Migration[]> {
  const schema = checkSchema(options.schema ?? DEFAULT_SCHEMA);
  const storeRole = checkRole(
    options.storeRole ?? DEFAULT_STORE_ROLE,
    "storeRole",
  );
  const tokenRole =
    options.tokenRole === undefined
      ? undefined
      : checkRole(options.tokenRole, "tokenRole");
  if (tokenRole === storeRole) {
    throw new BexioOAuthError(
      "invalid_config",
      "tokenRole must differ from storeRole",
    );
  }

  const names: Record<DefaultName, string> = {
    [DEFAULT_SCHEMA]: schema,
    [DEFAULT_STORE_ROLE]: storeRole,
    [DEFAULT_TOKEN_ROLE]: tokenRole ?? DEFAULT_TOKEN_ROLE,
  };
  const render = (sql: string) => renameDefaults(sql, names);

  return MIGRATIONS.map((m) => ({
    number: m.number,
    name: m.name,
    sql:
      tokenRole && m.tokenRoleSql
        ? `${render(m.sql).trimEnd()}\n\n${render(m.tokenRoleSql)}`
        : render(m.sql),
  }));
}
