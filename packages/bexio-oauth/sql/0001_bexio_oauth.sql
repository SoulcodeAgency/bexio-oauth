-- @soulcode/bexio-oauth 0001: connections and grants.
-- Token columns hold JWE ciphertext; only your server-side database role
-- should be able to read these tables.

-- One row per Bexio identity (company, user): the tokens of its one refresh
-- token chain, shared by every owner that connected this identity.
CREATE TABLE IF NOT EXISTS bexio_connections (
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
  last_refreshed_at     timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bexio_connections_company_user_key UNIQUE (bexio_company_id, bexio_user_id)
);

-- refreshIdle(): active connections by last refresh.
CREATE INDEX IF NOT EXISTS bexio_connections_idle_idx
  ON bexio_connections (last_refreshed_at)
  WHERE status = 'active';

-- One row per (owner, connection): an owner's access to a connection. A
-- connection is deleted only once no grant references it (RESTRICT).
CREATE TABLE IF NOT EXISTS bexio_grants (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      text        NOT NULL,
  connection_id uuid        NOT NULL REFERENCES bexio_connections (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bexio_grants_owner_connection_key UNIQUE (owner_id, connection_id)
);

-- Disconnect checks whether a connection has grants left.
CREATE INDEX IF NOT EXISTS bexio_grants_connection_idx
  ON bexio_grants (connection_id);
