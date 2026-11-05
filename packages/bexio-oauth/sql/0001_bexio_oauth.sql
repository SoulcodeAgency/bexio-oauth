-- @soulcode/bexio-oauth 0001: schema, store role, connections and grants.
--
-- The tables live in their own schema, and only a dedicated login role can
-- reach them. `npx @soulcode/bexio-oauth sql --schema <name> --store-role
-- <name>` prints this file with other names. Applying it twice in a row is
-- safe. Token columns hold JWE ciphertext.
--
-- Set the role's password out of band, per environment, never in a migration:
--   ALTER ROLE bexio_store PASSWORD '…';

CREATE SCHEMA IF NOT EXISTS bexio_oauth;

-- The role your app's grant store connects as. Roles are cluster-wide and
-- survive a database reset, so it is created only if it doesn't exist yet.
-- An existing role must be a plain login role: a superuser, BYPASSRLS or
-- otherwise privileged role, or a member of other roles, would void
-- everything below, so the migration stops instead of granting to it.
DO $$
DECLARE
  existing pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO existing FROM pg_roles WHERE rolname = 'bexio_store';
  IF NOT FOUND THEN
    CREATE ROLE bexio_store LOGIN NOINHERIT;
  ELSIF NOT existing.rolcanlogin OR existing.rolsuper OR existing.rolbypassrls
    OR existing.rolcreaterole OR existing.rolcreatedb OR existing.rolreplication
    OR EXISTS (SELECT FROM pg_auth_members WHERE member = existing.oid) THEN
    RAISE EXCEPTION 'role % exists but is not a plain login role', 'bexio_store'
      USING HINT = 'Choose another role name, or drop the role and run this again.';
  END IF;
END $$;

-- One row per Bexio identity (company, user): the tokens of its one refresh
-- token chain, shared by every owner that connected this identity.
CREATE TABLE IF NOT EXISTS bexio_oauth.bexio_connections (
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
  ON bexio_oauth.bexio_connections (last_refreshed_at)
  WHERE status = 'active';

-- One row per (owner, connection): an owner's access to a connection. A
-- connection is deleted only once no grant references it (RESTRICT).
CREATE TABLE IF NOT EXISTS bexio_oauth.bexio_grants (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      text        NOT NULL,
  connection_id uuid        NOT NULL REFERENCES bexio_oauth.bexio_connections (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bexio_grants_owner_connection_key UNIQUE (owner_id, connection_id)
);

-- Disconnect checks whether a connection has grants left.
CREATE INDEX IF NOT EXISTS bexio_grants_connection_idx
  ON bexio_oauth.bexio_grants (connection_id);

-- Nobody else reaches the schema or the tables: not PUBLIC, and not the API
-- roles of hosted Postgres platforms (Supabase), revoked where they exist.
REVOKE ALL ON SCHEMA bexio_oauth FROM PUBLIC;
REVOKE ALL ON bexio_oauth.bexio_connections, bexio_oauth.bexio_grants FROM PUBLIC;
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA bexio_oauth FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON bexio_oauth.bexio_connections, bexio_oauth.bexio_grants FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA bexio_oauth TO bexio_store;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON bexio_oauth.bexio_connections, bexio_oauth.bexio_grants TO bexio_store;

-- Row-level security on, with an explicit policy for the store role. The role
-- is neither the tables' owner nor BYPASSRLS, so RLS without a policy would
-- deny it every row. Any other role that is ever granted access sees nothing
-- (the owner and BYPASSRLS roles excepted). Each policy is named after its
-- role, so policies for other roles on the same tables stay untouched.
ALTER TABLE bexio_oauth.bexio_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE bexio_oauth.bexio_grants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bexio_store ON bexio_oauth.bexio_connections;
CREATE POLICY bexio_store ON bexio_oauth.bexio_connections
  FOR ALL TO bexio_store USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS bexio_store ON bexio_oauth.bexio_grants;
CREATE POLICY bexio_store ON bexio_oauth.bexio_grants
  FOR ALL TO bexio_store USING (true) WITH CHECK (true);
