import { Pool } from "pg";
import { env } from "./env";

let pool: Pool | undefined;

/**
 * Direct Postgres connection for the grant store (on hosted Supabase: the
 * pooler connection string). supabase-js can't run the store's atomic SQL.
 */
export function getPool(): Pool {
  return (pool ??= new Pool({ connectionString: env("DATABASE_URL") }));
}
