-- Local development only: the password the grant store logs in with
-- (DATABASE_URL in .env.example). Supabase also runs this file on preview
-- branches and on `db push --include-seed`: with either, remove this line.
-- On a hosted project, set a strong password once, out of band (SQL editor),
-- and never commit it:
--   ALTER ROLE bexio_store PASSWORD '<generated>';
ALTER ROLE bexio_store PASSWORD 'bexio-store-local-only';
