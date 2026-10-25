import { BexioOAuthError } from "../errors.js";
import type { ConnectionRecord, GrantRecord, GrantStore } from "./types.js";

/**
 * The only thing the Postgres store needs from a driver. A `pg` `Pool` or
 * `Client` matches it as is; other drivers need a few lines of wrapper.
 */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

// `id` columns are uuids: any other value matches no row, and would make
// Postgres reject the cast instead of returning nothing.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CONNECTION_COLUMNS = `id, bexio_company_id, bexio_user_id, bexio_company_user_id,
  company_name, user_name, user_email, role, status, access_token, refresh_token,
  access_expires_at, refresh_expires_at, scope, refresh_locked_until,
  authorized_at, last_refreshed_at, created_at, updated_at`;

/** Connection columns qualified with `c.`, for joins. */
const C_COLUMNS = CONNECTION_COLUMNS.split(",")
  .map((column) => `c.${column.trim()}`)
  .join(", ");

/** A grant joined with its connection (`c`) and the grant (`g`). */
const GRANT_COLUMNS = `g.id AS grant_id, g.owner_id, g.created_at AS grant_created_at, ${C_COLUMNS}`;

/**
 * The connection's columns an upsert sets, and the value each takes. They
 * change only for an authorization at least as new as the stored one: Bexio
 * has invalidated the older chain, so a slow connect that authorized earlier
 * must not overwrite a later one. The grant is linked either way.
 */
const UPSERT_VALUES: [column: string, value: string][] = [
  ["bexio_company_user_id", "EXCLUDED.bexio_company_user_id"],
  ["company_name", "EXCLUDED.company_name"],
  ["user_name", "EXCLUDED.user_name"],
  ["user_email", "EXCLUDED.user_email"],
  ["role", "EXCLUDED.role"],
  ["status", "'active'"],
  ["access_token", "EXCLUDED.access_token"],
  ["refresh_token", "EXCLUDED.refresh_token"],
  ["access_expires_at", "EXCLUDED.access_expires_at"],
  ["refresh_expires_at", "EXCLUDED.refresh_expires_at"],
  ["scope", "EXCLUDED.scope"],
  ["refresh_locked_until", "NULL"],
  ["refresh_lock_token", "NULL"],
  ["authorized_at", "EXCLUDED.authorized_at"],
  ["last_refreshed_at", "EXCLUDED.last_refreshed_at"],
  ["updated_at", "EXCLUDED.updated_at"],
];
const NEWER_AUTHORIZATION_WINS = UPSERT_VALUES.map(
  ([column, value]) =>
    `${column} = CASE WHEN EXCLUDED.authorized_at >= bexio_connections.authorized_at
       THEN ${value} ELSE bexio_connections.${column} END`,
).join(",\n             ");

/** SQLSTATE for a foreign key violation. */
const FOREIGN_KEY_VIOLATION = "23503";

interface ConnectionRow {
  id: string;
  bexio_company_id: string;
  bexio_user_id: string;
  bexio_company_user_id: number | null;
  company_name: string | null;
  user_name: string | null;
  user_email: string | null;
  role: ConnectionRecord["role"];
  status: ConnectionRecord["status"];
  access_token: string;
  refresh_token: string | null;
  access_expires_at: Date | string | null;
  refresh_expires_at: Date | string | null;
  scope: string | null;
  refresh_locked_until: Date | string | null;
  authorized_at: Date | string;
  last_refreshed_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface GrantRow extends ConnectionRow {
  grant_id: string;
  owner_id: string;
  grant_created_at: Date | string;
}

// Drivers differ: `pg` returns Date objects, HTTP drivers often ISO strings.
function date(value: Date | string): Date;
function date(value: Date | string | null): Date | null;
function date(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

function toConnection(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
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
    authorizedAt: date(row.authorized_at),
    lastRefreshedAt: date(row.last_refreshed_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

function toGrant(row: GrantRow): GrantRecord {
  return {
    id: row.grant_id,
    ownerId: row.owner_id,
    createdAt: date(row.grant_created_at),
    connection: toConnection(row),
  };
}

/**
 * Store on the `bexio_connections` and `bexio_grants` tables (create them
 * with `npx @soulcode/bexio-oauth sql`). Every operation is a single
 * statement, so it works through transaction-mode poolers and HTTP drivers.
 */
export function postgresStore(sql: SqlClient): GrantStore {
  const connection = async (text: string, params: unknown[]) => {
    const { rows } = await sql.query(text, params);
    return rows[0] ? toConnection(rows[0] as ConnectionRow) : null;
  };

  return {
    async upsertGrant(g) {
      const { rows } = await sql.query(
        `WITH connection AS (
           INSERT INTO bexio_connections (bexio_company_id, bexio_user_id,
             bexio_company_user_id, company_name, user_name, user_email, role, status,
             access_token, refresh_token, access_expires_at, refresh_expires_at, scope,
             refresh_locked_until, refresh_lock_token, authorized_at, last_refreshed_at,
             created_at, updated_at)
           VALUES ($2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $11, $12, $13, NULL, NULL, $15, $14, $14, $14)
           ON CONFLICT (bexio_company_id, bexio_user_id) DO UPDATE SET
             ${NEWER_AUTHORIZATION_WINS}
           RETURNING ${CONNECTION_COLUMNS}
         ), g AS (
           INSERT INTO bexio_grants (owner_id, connection_id, created_at)
           SELECT $1, id, $14 FROM connection
           ON CONFLICT (owner_id, connection_id) DO UPDATE SET owner_id = EXCLUDED.owner_id
           RETURNING id, owner_id, created_at
         )
         SELECT ${GRANT_COLUMNS} FROM g, connection c`,
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
          g.authorizedAt,
        ],
      );
      if (!rows[0]) {
        throw new BexioOAuthError(
          "invalid_config",
          "SqlClient returned no row for INSERT … RETURNING; check the driver wrapper",
        );
      }
      return toGrant(rows[0] as GrantRow);
    },

    async findGrants({ ownerId, companyId, grantId }) {
      if (grantId !== undefined && !UUID.test(grantId)) return [];
      const { rows } = await sql.query(
        `SELECT ${GRANT_COLUMNS}
         FROM bexio_grants g JOIN bexio_connections c ON c.id = g.connection_id
         WHERE g.owner_id = $1
           AND ($2::text IS NULL OR c.bexio_company_id = $2)
           AND ($3::uuid IS NULL OR g.id = $3::uuid)
         ORDER BY g.created_at, g.id`,
        [ownerId, companyId ?? null, grantId ?? null],
      );
      return (rows as GrantRow[]).map(toGrant);
    },

    async deleteGrant(id) {
      if (!UUID.test(id)) return;
      await sql.query(`DELETE FROM bexio_grants WHERE id = $1`, [id]);
    },

    async getConnection(id) {
      if (!UUID.test(id)) return null;
      return connection(
        `SELECT ${CONNECTION_COLUMNS} FROM bexio_connections WHERE id = $1`,
        [id],
      );
    },

    // NOT EXISTS reads the statement's snapshot, so it can miss a grant that
    // a concurrent upsertGrant commits meanwhile. The foreign key catches
    // that case: it checks against committed data and fails the delete.
    async deleteUnusedConnection(id) {
      if (!UUID.test(id)) return null;
      try {
        const { rows } = await sql.query(
          `DELETE FROM bexio_connections c
           WHERE c.id = $1
             AND NOT EXISTS (SELECT 1 FROM bexio_grants g WHERE g.connection_id = c.id)
           RETURNING ${C_COLUMNS}, EXISTS (
             SELECT 1 FROM bexio_connections o
             WHERE o.bexio_user_id = c.bexio_user_id AND o.id <> c.id
           ) AS user_has_other_connections`,
          [id],
        );
        const row = rows[0] as
          (ConnectionRow & { user_has_other_connections: boolean }) | undefined;
        return row
          ? {
              connection: toConnection(row),
              userHasOtherConnections: row.user_has_other_connections,
            }
          : null;
      } catch (error) {
        if ((error as { code?: unknown }).code === FOREIGN_KEY_VIOLATION)
          return null;
        throw error;
      }
    },

    async acquireRefreshLock({
      id,
      now,
      lockUntil,
      lockToken,
      accessExpiresBefore,
      refreshedBefore,
    }) {
      return connection(
        `UPDATE bexio_connections SET refresh_locked_until = $3, refresh_lock_token = $6
         WHERE id = $1
           AND status = 'active'
           AND (refresh_locked_until IS NULL OR refresh_locked_until <= $2)
           AND (
             ($4::timestamptz IS NOT NULL AND (access_expires_at IS NULL OR access_expires_at <= $4))
             OR ($5::timestamptz IS NOT NULL AND last_refreshed_at < $5)
           )
         RETURNING ${CONNECTION_COLUMNS}`,
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
      return connection(
        `UPDATE bexio_connections SET
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
         RETURNING ${CONNECTION_COLUMNS}`,
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
      return connection(
        `UPDATE bexio_connections SET status = 'reauth_required',
           refresh_locked_until = NULL, refresh_lock_token = NULL, updated_at = $2
         WHERE id = $1 AND refresh_lock_token = $3
         RETURNING ${CONNECTION_COLUMNS}`,
        [id, now, lockToken],
      );
    },

    async releaseRefreshLock(id, lockToken) {
      await sql.query(
        `UPDATE bexio_connections SET refresh_locked_until = NULL, refresh_lock_token = NULL
         WHERE id = $1 AND refresh_lock_token = $2`,
        [id, lockToken],
      );
    },

    async listIdleConnections({ refreshedBefore, limit }) {
      const { rows } = await sql.query(
        `SELECT ${CONNECTION_COLUMNS} FROM bexio_connections c
         WHERE c.status = 'active' AND c.last_refreshed_at < $1
           AND EXISTS (SELECT 1 FROM bexio_grants g WHERE g.connection_id = c.id)
         ORDER BY c.last_refreshed_at
         LIMIT $2`,
        [refreshedBefore, limit],
      );
      return (rows as ConnectionRow[]).map(toConnection);
    },
  };
}
