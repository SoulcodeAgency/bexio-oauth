-- 0001_bexio_grants.sql
-- @soulcode/bexio-oauth 0001: the grants table.
-- One row per (owner, Bexio company, Bexio user). Token columns hold JWE
-- ciphertext; only your server-side database role should be able to read them.

CREATE TABLE IF NOT EXISTS bexio_grants (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              text        NOT NULL,
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
  CONSTRAINT bexio_grants_owner_company_user_key UNIQUE (owner_id, bexio_company_id, bexio_user_id)
);

-- refreshIdle(): active grants by last refresh.
CREATE INDEX IF NOT EXISTS bexio_grants_idle_idx
  ON bexio_grants (last_refreshed_at)
  WHERE status = 'active';

-- Only the server (direct Postgres connection) may read grants: RLS on,
-- no policies, so the anon and authenticated roles see nothing.
ALTER TABLE bexio_grants ENABLE ROW LEVEL SECURITY;
