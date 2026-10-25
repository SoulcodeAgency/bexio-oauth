import { randomUUID } from "node:crypto";
import type {
  ConnectionRecord,
  ConnectionRefresh,
  GrantRecord,
  GrantStore,
  GrantUpsert,
  LockRequest,
} from "./types.js";

interface StoredGrant {
  id: string;
  ownerId: string;
  connectionId: string;
  createdAt: Date;
}

/**
 * In-memory store for tests. Same semantics as `postgresStore`, but data
 * lives in this process only.
 */
export function memoryStore(): GrantStore {
  const connections = new Map<string, ConnectionRecord>();
  const grants = new Map<string, StoredGrant>();
  const lockTokens = new Map<string, string>();
  const copy = (row: ConnectionRecord): ConnectionRecord => ({ ...row });
  const joined = (grant: StoredGrant): GrantRecord => ({
    id: grant.id,
    ownerId: grant.ownerId,
    createdAt: grant.createdAt,
    connection: copy(connections.get(grant.connectionId)!),
  });
  const held = (id: string, lockToken: string) => {
    const row = connections.get(id);
    if (!row || lockTokens.get(id) !== lockToken) return null;
    lockTokens.delete(id);
    row.refreshLockedUntil = null;
    return row;
  };

  return {
    async upsertGrant(input: GrantUpsert) {
      const { ownerId, now, ...fields } = input;
      const existing = [...connections.values()].find(
        (c) => c.companyId === input.companyId && c.userId === input.userId,
      );
      const connection: ConnectionRecord = {
        id: existing?.id ?? randomUUID(),
        ...fields,
        status: "active",
        refreshLockedUntil: null,
        lastRefreshedAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      connections.set(connection.id, connection);
      lockTokens.delete(connection.id);
      let grant = [...grants.values()].find(
        (g) => g.ownerId === ownerId && g.connectionId === connection.id,
      );
      if (!grant) {
        grant = {
          id: randomUUID(),
          ownerId,
          connectionId: connection.id,
          createdAt: now,
        };
        grants.set(grant.id, grant);
      }
      return joined(grant);
    },

    async findGrants({ ownerId, companyId, grantId }) {
      return [...grants.values()]
        .filter(
          (g) =>
            g.ownerId === ownerId &&
            (companyId === undefined ||
              connections.get(g.connectionId)!.companyId === companyId) &&
            (grantId === undefined || g.id === grantId),
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(joined);
    },

    async deleteGrant(id) {
      grants.delete(id);
    },

    async getConnection(id) {
      const row = connections.get(id);
      return row ? copy(row) : null;
    },

    async deleteUnusedConnection(id) {
      const row = connections.get(id);
      if (!row || [...grants.values()].some((g) => g.connectionId === id))
        return null;
      connections.delete(id);
      lockTokens.delete(id);
      return copy(row);
    },

    async acquireRefreshLock(req: LockRequest) {
      const row = connections.get(req.id);
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
      lockTokens.set(row.id, req.lockToken);
      return copy(row);
    },

    async saveRefreshed(id, lockToken, refresh: ConnectionRefresh) {
      const row = held(id, lockToken);
      if (!row) return null;
      row.accessToken = refresh.accessToken;
      row.refreshToken = refresh.refreshToken ?? row.refreshToken;
      row.accessExpiresAt = refresh.accessExpiresAt;
      row.refreshExpiresAt = refresh.refreshExpiresAt ?? row.refreshExpiresAt;
      row.scope = refresh.scope ?? row.scope;
      row.role = refresh.role ?? row.role;
      row.status = "active";
      row.lastRefreshedAt = refresh.now;
      row.updatedAt = refresh.now;
      return copy(row);
    },

    async markReauthRequired(id, lockToken, now) {
      const row = held(id, lockToken);
      if (!row) return null;
      row.status = "reauth_required";
      row.updatedAt = now;
      return copy(row);
    },

    async releaseRefreshLock(id, lockToken) {
      held(id, lockToken);
    },

    async listIdleConnections({ refreshedBefore, limit }) {
      const linked = new Set([...grants.values()].map((g) => g.connectionId));
      return [...connections.values()]
        .filter(
          (c) =>
            c.status === "active" &&
            c.lastRefreshedAt < refreshedBefore &&
            linked.has(c.id),
        )
        .sort(
          (a, b) => a.lastRefreshedAt.getTime() - b.lastRefreshedAt.getTime(),
        )
        .slice(0, limit)
        .map(copy);
    },
  };
}
