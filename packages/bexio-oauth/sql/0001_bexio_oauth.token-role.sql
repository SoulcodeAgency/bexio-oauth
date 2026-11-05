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

-- Created like the store role, and refused like it when an existing role of
-- that name is privileged or a member of other roles.
DO $$
DECLARE
  existing pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO existing FROM pg_roles WHERE rolname = 'bexio_token';
  IF NOT FOUND THEN
    CREATE ROLE bexio_token LOGIN NOINHERIT;
  ELSIF NOT existing.rolcanlogin OR existing.rolsuper OR existing.rolbypassrls
    OR existing.rolcreaterole OR existing.rolcreatedb OR existing.rolreplication
    OR EXISTS (SELECT FROM pg_auth_members WHERE member = existing.oid) THEN
    RAISE EXCEPTION 'role % exists but is not a plain login role', 'bexio_token'
      USING HINT = 'Choose another role name, or drop the role and run this again.';
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
