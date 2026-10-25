// Creates the tables this example needs: Better Auth's (user, session,
// account, verification) and the library's bexio_grants. Idempotent.
// Run with: npm run migrate
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { migrations } from "@soulcode/bexio-oauth";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const pool = new pg.Pool({ connectionString: url });

for (const m of await migrations()) await pool.query(m.sql);

const { runMigrations } = await getMigrations(
  betterAuth({ database: pool, secret: "migrations-only-migrations-only" })
    .options,
);
await runMigrations();
await pool.end();
console.log("Migrations applied.");
