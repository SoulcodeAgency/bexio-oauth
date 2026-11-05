import { Pool } from "pg";
import { env } from "./env";

let pool: Pool | undefined;
let bexioPool: Pool | undefined;

/** Better Auth's connection: its own tables in `public`. */
export function getPool(): Pool {
  return (pool ??= new Pool({ connectionString: env("DATABASE_URL") }));
}

/**
 * The grant store's connection, as `bexio_store`: it reaches the library's
 * two tables in the `bexio_oauth` schema and nothing else, not even Better
 * Auth's tables. Its statements are short and single, so a few connections
 * are plenty: keep the total per process (and per serverless instance) low.
 */
export function getBexioPool(): Pool {
  return (bexioPool ??= new Pool({
    connectionString: env("BEXIO_DATABASE_URL"),
    max: 3,
  }));
}
