-- 0001_bexio_oauth.sql
-- @soulcode/bexio-oauth 0001: schema, store role, connections and grants.
--
-- The tables live in their own schema, and only a dedicated login role can
-- reach them. `npx @soulcode/bexio-oauth sql --schema <name> --store-role
-- <name>` prints this file with other names. Applying it twice in a row is
-- safe. Token columns hold JWE ciphertext.
--
-- Set the role's password out of band, per environment, never in a migration:
--   ALTER ROLE "app_store" PASSWORD '…';

CREATE SCHEMA IF NOT EXISTS "app_tokens";

-- The role your app's grant store connects as. Roles are cluster-wide and
-- survive a database reset, so it is created only if it doesn't exist yet.
-- An existing role must be a plain login role: a superuser, BYPASSRLS or
-- otherwise privileged role, or a member of other roles, would void
-- everything below, so the migration stops instead of granting to it.
DO $$
DECLARE
  existing pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO existing FROM pg_roles WHERE rolname = 'app_store';
  IF NOT FOUND THEN
    CREATE ROLE "app_store" LOGIN NOINHERIT;
  ELSIF NOT existing.rolcanlogin OR existing.rolsuper OR existing.rolbypassrls
    OR existing.rolcreaterole OR existing.rolcreatedb OR existing.rolreplication
    OR EXISTS (SELECT FROM pg_auth_members WHERE member = existing.oid) THEN
    RAISE EXCEPTION 'role % exists but is not a plain login role', 'app_store'
      USING HINT = 'Choose another role name, or drop the role and run this again.';
  END IF;
END $$;

-- One row per Bexio identity (company, user): the tokens of its one refresh
-- token chain, shared by every owner that connected this identity.
CREATE TABLE IF NOT EXISTS "app_tokens".bexio_connections (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bexio_company_id      text        NOT NULL,
  bexio_user_id         text        NOT NULL,
  bexio_company_user_id integer,
  company_name          text,
  user_name             text,
  user_email            text,
  role                  text        NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status                text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauth_required')),
  access_token          text        NOT NULL,
  refresh_token         text,
  access_expires_at     timestamptz,
  refresh_expires_at    timestamptz,
  scope                 text,
  refresh_locked_until  timestamptz,
  refresh_lock_token    text,
  authorized_at         timestamptz NOT NULL,
  last_refreshed_at     timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bexio_connections_company_user_key UNIQUE (bexio_company_id, bexio_user_id)
);

-- refreshIdle(): active connections by last refresh.
CREATE INDEX IF NOT EXISTS bexio_connections_idle_idx
  ON "app_tokens".bexio_connections (last_refreshed_at)
  WHERE status = 'active';

-- One row per (owner, connection): an owner's access to a connection. A
-- connection is deleted only once no grant references it (RESTRICT).
CREATE TABLE IF NOT EXISTS "app_tokens".bexio_grants (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      text        NOT NULL,
  connection_id uuid        NOT NULL REFERENCES "app_tokens".bexio_connections (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bexio_grants_owner_connection_key UNIQUE (owner_id, connection_id)
);

-- Disconnect checks whether a connection has grants left.
CREATE INDEX IF NOT EXISTS bexio_grants_connection_idx
  ON "app_tokens".bexio_grants (connection_id);

-- Nobody else reaches the schema or the tables: not PUBLIC, and not the API
-- roles of hosted Postgres platforms (Supabase), revoked where they exist.
REVOKE ALL ON SCHEMA "app_tokens" FROM PUBLIC;
REVOKE ALL ON "app_tokens".bexio_connections, "app_tokens".bexio_grants FROM PUBLIC;
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA "app_tokens" FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON "app_tokens".bexio_connections, "app_tokens".bexio_grants FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA "app_tokens" TO "app_store";
GRANT SELECT, INSERT, UPDATE, DELETE
  ON "app_tokens".bexio_connections, "app_tokens".bexio_grants TO "app_store";

-- Row-level security on, with an explicit policy for the store role. The role
-- is neither the tables' owner nor BYPASSRLS, so RLS without a policy would
-- deny it every row. Any other role that is ever granted access sees nothing
-- (the owner and BYPASSRLS roles excepted). Each policy is named after its
-- role, so policies for other roles on the same tables stay untouched.
ALTER TABLE "app_tokens".bexio_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app_tokens".bexio_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "app_store" ON "app_tokens".bexio_connections;
CREATE POLICY "app_store" ON "app_tokens".bexio_connections
  FOR ALL TO "app_store" USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "app_store" ON "app_tokens".bexio_grants;
CREATE POLICY "app_store" ON "app_tokens".bexio_grants
  FOR ALL TO "app_store" USING (true) WITH CHECK (true);

-- @soulcode/bexio-oauth 0001, optional token role.
--
-- A narrower login role for runtimes that only use tokens: getAccessToken,
-- listGrants and refreshIdle. It reads both tables and updates only a
-- connection's token, lock, role and status columns, so a leaked credential
-- can't add or delete grants or connections, or change whose tokens a
-- connection holds.
-- Printed after 0001 with `npx @soulcode/bexio-oauth sql --token-role <name>`.
-- Set its password out of band too:
--   ALTER ROLE "app_token" PASSWORD '…';

-- Created like the store role, and refused like it when an existing role of
-- that name is privileged or a member of other roles.
DO $$
DECLARE
  existing pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO existing FROM pg_roles WHERE rolname = 'app_token';
  IF NOT FOUND THEN
    CREATE ROLE "app_token" LOGIN NOINHERIT;
  ELSIF NOT existing.rolcanlogin OR existing.rolsuper OR existing.rolbypassrls
    OR existing.rolcreaterole OR existing.rolcreatedb OR existing.rolreplication
    OR EXISTS (SELECT FROM pg_auth_members WHERE member = existing.oid) THEN
    RAISE EXCEPTION 'role % exists but is not a plain login role', 'app_token'
      USING HINT = 'Choose another role name, or drop the role and run this again.';
  END IF;
END $$;

GRANT USAGE ON SCHEMA "app_tokens" TO "app_token";
GRANT SELECT ON "app_tokens".bexio_connections, "app_tokens".bexio_grants TO "app_token";
GRANT UPDATE (
  access_token, refresh_token, access_expires_at, refresh_expires_at, scope,
  role, status, refresh_locked_until, refresh_lock_token, last_refreshed_at,
  updated_at
) ON "app_tokens".bexio_connections TO "app_token";

-- Named after the role, like the store role's: several token roles on one
-- schema each keep their own. The grants above limit what the role may do.
DROP POLICY IF EXISTS "app_token" ON "app_tokens".bexio_connections;
CREATE POLICY "app_token" ON "app_tokens".bexio_connections
  FOR ALL TO "app_token" USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "app_token" ON "app_tokens".bexio_grants;
CREATE POLICY "app_token" ON "app_tokens".bexio_grants
  FOR ALL TO "app_token" USING (true) WITH CHECK (true);
