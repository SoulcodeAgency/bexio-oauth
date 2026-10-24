import { randomUUID } from "node:crypto";
import type {
  GrantRecord,
  GrantRefresh,
  GrantStore,
  GrantUpsert,
  LockRequest,
} from "./types.js";

/**
 * In-memory store for tests. Same semantics as `postgresStore`, but data
 * lives in this process only.
 */
export function memoryStore(): GrantStore {
  const rows = new Map<string, GrantRecord>();
  const copy = (row: GrantRecord): GrantRecord => ({ ...row });

  return {
    async upsertGrant(input: GrantUpsert) {
      const existing = [...rows.values()].find(
        (r) =>
          r.ownerId === input.ownerId &&
          r.companyId === input.companyId &&
          r.userId === input.userId,
      );
      const { now, ...fields } = input;
      const row: GrantRecord = {
        id: existing?.id ?? randomUUID(),
        ...fields,
        status: "active",
        refreshLockedUntil: null,
        lastRefreshedAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      rows.set(row.id, row);
      return copy(row);
    },

    async findGrants({ ownerId, companyId, grantId }) {
      return [...rows.values()]
        .filter(
          (r) =>
            r.ownerId === ownerId &&
            (companyId === undefined || r.companyId === companyId) &&
            (grantId === undefined || r.id === grantId),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(copy);
    },

    async getGrant(id) {
      const row = rows.get(id);
      return row ? copy(row) : null;
    },

    async acquireRefreshLock(req: LockRequest) {
      const row = rows.get(req.id);
      if (!row || row.status !== "active") return null;
      if (row.refreshLockedUntil && row.refreshLockedUntil > req.now)
        return null;
      const needsRefresh =
        (req.accessExpiresBefore !== undefined &&
          (row.accessExpiresAt === null ||
            row.accessExpiresAt <= req.accessExpiresBefore)) ||
        (req.refreshedBefore !== undefined &&
          row.lastRefreshedAt < req.refreshedBefore);
      if (!needsRefresh) return null;
      row.refreshLockedUntil = req.lockUntil;
      return copy(row);
    },

    async saveRefreshed(id, refresh: GrantRefresh) {
      const row = rows.get(id);
      if (!row) return null;
      row.accessToken = refresh.accessToken;
      row.refreshToken = refresh.refreshToken ?? row.refreshToken;
      row.accessExpiresAt = refresh.accessExpiresAt;
      row.refreshExpiresAt = refresh.refreshExpiresAt ?? row.refreshExpiresAt;
      row.scope = refresh.scope ?? row.scope;
      row.role = refresh.role ?? row.role;
      row.status = "active";
      row.refreshLockedUntil = null;
      row.lastRefreshedAt = refresh.now;
      row.updatedAt = refresh.now;
      return copy(row);
    },

    async markReauthRequired(id, now) {
      const row = rows.get(id);
      if (!row) return;
      row.status = "reauth_required";
      row.refreshLockedUntil = null;
      row.updatedAt = now;
    },

    async releaseRefreshLock(id) {
      const row = rows.get(id);
      if (row) row.refreshLockedUntil = null;
    },

    async deleteGrant(id) {
      rows.delete(id);
    },

    async listIdleGrants({ refreshedBefore, limit }) {
      return [...rows.values()]
        .filter(
          (r) => r.status === "active" && r.lastRefreshedAt < refreshedBefore,
        )
        .sort(
          (a, b) => a.lastRefreshedAt.getTime() - b.lastRefreshedAt.getTime(),
        )
        .slice(0, limit)
        .map(copy);
    },
  };
}
