-- Local development only: the password the grant store logs in with
-- (DATABASE_URL in .env.example). On a hosted project, set a strong one once,
-- out of band (SQL editor), and never commit it:
--   ALTER ROLE bexio_store PASSWORD '<generated>';
ALTER ROLE bexio_store PASSWORD 'bexio-store-local-only';
