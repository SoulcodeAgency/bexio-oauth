// Creates the tables this example needs: the library's bexio_oauth schema
// with its bexio_store role, and Better Auth's (user, session, account,
// verification). Idempotent. Run with: npm run migrate
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { migrations } from "@soulcode/bexio-oauth";
import pg, { escapeIdentifier, escapeLiteral } from "pg";

const url = process.env.DATABASE_URL;
const bexioUrl = process.env.BEXIO_DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
if (!bexioUrl) throw new Error("BEXIO_DATABASE_URL is not set");
const pool = new pg.Pool({ connectionString: url });

// The store role is the user in BEXIO_DATABASE_URL.
const store = new URL(bexioUrl);
const storeRole = decodeURIComponent(store.username);
for (const m of await migrations({ storeRole })) await pool.query(m.sql);

// Local development only, so only against a local database: a real app sets
// the password once per environment, out of band, and never from code or a
// migration (the statement would also land in the server's DDL log).
if (["localhost", "127.0.0.1", "[::1]"].includes(store.hostname)) {
  await pool.query(
    `ALTER ROLE ${escapeIdentifier(storeRole)} PASSWORD ${escapeLiteral(decodeURIComponent(store.password))}`,
  );
} else {
  console.log(`Not a local database: set ${storeRole}'s password yourself.`);
}

const { runMigrations } = await getMigrations(
  betterAuth({ database: pool, secret: "migrations-only-migrations-only" })
    .options,
);
await runMigrations();
await pool.end();
console.log("Migrations applied.");
