import { Pool } from "pg";
import { env } from "./env";

let pool: Pool | undefined;

/** One pool per server process, shared by Better Auth and the grant store. */
export function getPool(): Pool {
  return (pool ??= new Pool({ connectionString: env("DATABASE_URL") }));
}
