-- @soulcode/bexio-oauth 0001, optional token role.
--
-- A narrower login role for runtimes that only use tokens: getAccessToken,
-- listGrants and refreshIdle. It reads both tables and updates only a
-- connection's token, lock, role and status columns, so a leaked credential
-- can't add or delete grants or connections, or change whose tokens a
-- connection holds.
-- Printed after 0001 with `npx @soulcode/bexio-oauth sql --token-role <name>`.
-- Set its password out of band too:
--   ALTER ROLE bexio_token PASSWORD '…';

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bexio_token') THEN
    CREATE ROLE bexio_token LOGIN NOINHERIT;
  END IF;
END $$;

GRANT USAGE ON SCHEMA bexio_oauth TO bexio_token;
GRANT SELECT ON bexio_oauth.bexio_connections, bexio_oauth.bexio_grants TO bexio_token;
GRANT UPDATE (
  access_token, refresh_token, access_expires_at, refresh_expires_at, scope,
  role, status, refresh_locked_until, refresh_lock_token, last_refreshed_at,
  updated_at
) ON bexio_oauth.bexio_connections TO bexio_token;

-- Named after the role, like the store role's: several token roles on one
-- schema each keep their own. The grants above limit what the role may do.
DROP POLICY IF EXISTS bexio_token ON bexio_oauth.bexio_connections;
CREATE POLICY bexio_token ON bexio_oauth.bexio_connections
  FOR ALL TO bexio_token USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS bexio_token ON bexio_oauth.bexio_grants;
CREATE POLICY bexio_token ON bexio_oauth.bexio_grants
  FOR ALL TO bexio_token USING (true) WITH CHECK (true);
