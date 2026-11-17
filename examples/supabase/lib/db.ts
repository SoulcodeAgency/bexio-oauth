import { Pool } from "pg";
import { env } from "./env";

let pool: Pool | undefined;

/**
 * Postgres connection for the grant store, as the `bexio_store` role: it can
 * reach the library's two tables in the `bexio_oauth` schema and nothing
 * else (hosted: the transaction pooler, user `bexio_store.<project-ref>`).
 * supabase-js can't run the store's atomic SQL, and the schema isn't exposed
 * through the Data API anyway.
 */
export function getPool(): Pool {
  return (pool ??= new Pool({ connectionString: env("DATABASE_URL") }));
}
