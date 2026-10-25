import type { GrantRecord, GrantStore } from "./types.js";

/**
 * The only thing the Postgres store needs from a driver. A `pg` `Pool` or
 * `Client` matches it as is; other drivers need a few lines of wrapper.
 */
export interface SqlClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

const COLUMNS = `id, owner_id, bexio_company_id, bexio_user_id, bexio_company_user_id,
  company_name, user_name, user_email, role, status, access_token, refresh_token,
  access_expires_at, refresh_expires_at, scope, refresh_locked_until,
  last_refreshed_at, created_at, updated_at`;

interface Row {
  id: string;
  owner_id: string;
  bexio_company_id: string;
  bexio_user_id: string;
  bexio_company_user_id: number | null;
  company_name: string | null;
  user_name: string | null;
  user_email: string | null;
  role: GrantRecord["role"];
  status: GrantRecord["status"];
  access_token: string;
  refresh_token: string | null;
  access_expires_at: Date | string | null;
  refresh_expires_at: Date | string | null;
  scope: string | null;
  refresh_locked_until: Date | string | null;
  last_refreshed_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

// Drivers differ: `pg` returns Date objects, HTTP drivers often ISO strings.
function date(value: Date | string): Date;
function date(value: Date | string | null): Date | null;
function date(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function toRecord(row: Row): GrantRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    companyId: row.bexio_company_id,
    userId: row.bexio_user_id,
    companyUserId:
      row.bexio_company_user_id === null
        ? null
        : Number(row.bexio_company_user_id),
    companyName: row.company_name,
    userName: row.user_name,
    userEmail: row.user_email,
    role: row.role,
    status: row.status,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    accessExpiresAt: date(row.access_expires_at),
    refreshExpiresAt: date(row.refresh_expires_at),
    scope: row.scope,
    refreshLockedUntil: date(row.refresh_locked_until),
    lastRefreshedAt: date(row.last_refreshed_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

/**
 * Grant store on the `bexio_grants` table (create it with
 * `npx @soulcode/bexio-oauth sql`). Every operation is a single statement,
 * so it works through transaction-mode poolers and HTTP drivers.
 */
export function postgresStore(sql: SqlClient): GrantStore {
  const one = async (text: string, params: unknown[]) => {
    const { rows } = await sql.query(text, params);
    return rows[0] ? toRecord(rows[0] as Row) : null;
  };
  const many = async (text: string, params: unknown[]) => {
    const { rows } = await sql.query(text, params);
    return (rows as Row[]).map(toRecord);
  };

  return {
    async upsertGrant(g) {
      const row = await one(
        `INSERT INTO bexio_grants (owner_id, bexio_company_id, bexio_user_id,
           bexio_company_user_id, company_name, user_name, user_email, role, status,
           access_token, refresh_token, access_expires_at, refresh_expires_at, scope,
           refresh_locked_until, last_refreshed_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $11, $12, $13, NULL, $14, $14, $14)
         ON CONFLICT (owner_id, bexio_company_id, bexio_user_id) DO UPDATE SET
           bexio_company_user_id = EXCLUDED.bexio_company_user_id,
           company_name = EXCLUDED.company_name,
           user_name = EXCLUDED.user_name,
           user_email = EXCLUDED.user_email,
           role = EXCLUDED.role,
           status = 'active',
           access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           access_expires_at = EXCLUDED.access_expires_at,
           refresh_expires_at = EXCLUDED.refresh_expires_at,
           scope = EXCLUDED.scope,
           refresh_locked_until = NULL,
           refresh_lock_token = NULL,
           last_refreshed_at = EXCLUDED.last_refreshed_at,
           updated_at = EXCLUDED.updated_at
         RETURNING ${COLUMNS}`,
        [
          g.ownerId,
          g.companyId,
          g.userId,
          g.companyUserId,
          g.companyName,
          g.userName,
          g.userEmail,
          g.role,
          g.accessToken,
          g.refreshToken,
          g.accessExpiresAt,
          g.refreshExpiresAt,
          g.scope,
          g.now,
        ],
      );
      if (!row) throw new Error("upsert returned no row");
      return row;
    },

    async findGrants({ ownerId, companyId, grantId }) {
      return many(
        `SELECT ${COLUMNS} FROM bexio_grants
         WHERE owner_id = $1
           AND ($2::text IS NULL OR bexio_company_id = $2)
           AND ($3::uuid IS NULL OR id = $3::uuid)
         ORDER BY created_at, id`,
        [ownerId, companyId ?? null, grantId ?? null],
      );
    },

    async getGrant(id) {
      return one(`SELECT ${COLUMNS} FROM bexio_grants WHERE id = $1`, [id]);
    },

    async acquireRefreshLock({
      id,
      now,
      lockUntil,
      lockToken,
      accessExpiresBefore,
      refreshedBefore,
    }) {
      return one(
        `UPDATE bexio_grants SET refresh_locked_until = $3, refresh_lock_token = $6
         WHERE id = $1
           AND status = 'active'
           AND (refresh_locked_until IS NULL OR refresh_locked_until <= $2)
           AND (
             ($4::timestamptz IS NOT NULL AND (access_expires_at IS NULL OR access_expires_at <= $4))
             OR ($5::timestamptz IS NOT NULL AND last_refreshed_at < $5)
           )
         RETURNING ${COLUMNS}`,
        [
          id,
          now,
          lockUntil,
          accessExpiresBefore ?? null,
          refreshedBefore ?? null,
          lockToken,
        ],
      );
    },

    // Holder writes are fenced by refresh_lock_token: a holder whose lock
    // expired or was cleared by a reconnect matches no row and changes nothing.
    async saveRefreshed(id, lockToken, r) {
      return one(
        `UPDATE bexio_grants SET
           access_token = $2,
           refresh_token = COALESCE($3, refresh_token),
           access_expires_at = $4,
           refresh_expires_at = COALESCE($5, refresh_expires_at),
           scope = COALESCE($6, scope),
           role = COALESCE($7, role),
           status = 'active',
           refresh_locked_until = NULL,
           refresh_lock_token = NULL,
           last_refreshed_at = $8,
           updated_at = $8
         WHERE id = $1 AND refresh_lock_token = $9
         RETURNING ${COLUMNS}`,
        [
          id,
          r.accessToken,
          r.refreshToken,
          r.accessExpiresAt,
          r.refreshExpiresAt,
          r.scope,
          r.role,
          r.now,
          lockToken,
        ],
      );
    },

    async markReauthRequired(id, lockToken, now) {
      await sql.query(
        `UPDATE bexio_grants SET status = 'reauth_required',
           refresh_locked_until = NULL, refresh_lock_token = NULL, updated_at = $2
         WHERE id = $1 AND refresh_lock_token = $3`,
        [id, now, lockToken],
      );
    },

    async releaseRefreshLock(id, lockToken) {
      await sql.query(
        `UPDATE bexio_grants SET refresh_locked_until = NULL, refresh_lock_token = NULL
         WHERE id = $1 AND refresh_lock_token = $2`,
        [id, lockToken],
      );
    },

    async deleteGrant(id) {
      await sql.query(`DELETE FROM bexio_grants WHERE id = $1`, [id]);
    },

    async listIdleGrants({ refreshedBefore, limit }) {
      return many(
        `SELECT ${COLUMNS} FROM bexio_grants
         WHERE status = 'active' AND last_refreshed_at < $1
         ORDER BY last_refreshed_at
         LIMIT $2`,
        [refreshedBefore, limit],
      );
    },
  };
}
