import type { Role } from "../permissions.js";

export type GrantStatus = "active" | "reauth_required";

/**
 * A stored connection: one Bexio identity (company, user) and the tokens of
 * its refresh token chain, shared by every owner that connected it. Token
 * fields hold JWE ciphertext, never plaintext.
 */
export interface ConnectionRecord {
  id: string;
  companyId: string;
  userId: string;
  companyUserId: number | null;
  companyName: string | null;
  userName: string | null;
  userEmail: string | null;
  role: Role;
  status: GrantStatus;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  scope: string | null;
  refreshLockedUntil: Date | null;
  lastRefreshedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** A stored grant: one owner's access to a connection. */
export interface GrantRecord {
  id: string;
  ownerId: string;
  createdAt: Date;
  connection: ConnectionRecord;
}

/**
 * Upsert of the connection for (company, user) with new tokens (status
 * `active`, lock cleared), and of the grant for (owner, that connection).
 */
export interface GrantUpsert {
  ownerId: string;
  companyId: string;
  userId: string;
  companyUserId: number | null;
  companyName: string | null;
  userName: string | null;
  userEmail: string | null;
  role: Role;
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  scope: string | null;
  now: Date;
}

export interface ConnectionRefresh {
  accessToken: string;
  /** `null` keeps the stored refresh token (the IdP didn't rotate it). */
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  /** `null` keeps the stored value. */
  refreshExpiresAt: Date | null;
  /** `null` keeps the stored value. */
  scope: string | null;
  /** `null` keeps the stored role. */
  role: Role | null;
  now: Date;
}

export interface LockRequest {
  /** The connection to lock. */
  id: string;
  now: Date;
  lockUntil: Date;
  /**
   * Random value identifying this lock holder. Writes that need the lock pass
   * it back, so a holder whose lock expired (or was cleared by a reconnect)
   * can't overwrite newer data.
   */
  lockToken: string;
  /** Lock only if the access token expires before this instant (lazy refresh)… */
  accessExpiresBefore?: Date;
  /** …or only if the connection was last refreshed before this instant (idle sweep). */
  refreshedBefore?: Date;
}

/**
 * Persistence for connections and grants. Every method must be atomic on its
 * own: the library never needs multi-statement transactions.
 */
export interface GrantStore {
  /** See `GrantUpsert`. Returns the grant with its connection. */
  upsertGrant(input: GrantUpsert): Promise<GrantRecord>;
  /** The owner's grants with their connections, oldest first. */
  findGrants(query: {
    ownerId: string;
    companyId?: string;
    grantId?: string;
  }): Promise<GrantRecord[]>;
  /** Deletes one grant; its connection stays. */
  deleteGrant(id: string): Promise<void>;
  getConnection(id: string): Promise<ConnectionRecord | null>;
  /**
   * Deletes the connection if no grant references it any more, and returns
   * the deleted row. Returns `null` (and changes nothing) while a grant still
   * references it, including one added concurrently.
   */
  deleteUnusedConnection(id: string): Promise<ConnectionRecord | null>;
  /**
   * Takes the refresh lock if the connection is active, not locked (or the
   * lock expired), and still matches the `accessExpiresBefore` /
   * `refreshedBefore` condition. Returns the locked row, or `null` if someone
   * else holds the lock or the connection no longer needs a refresh.
   */
  acquireRefreshLock(request: LockRequest): Promise<ConnectionRecord | null>;
  /**
   * Stores refreshed tokens, sets `lastRefreshedAt`, and releases the lock.
   * Returns `null` (and changes nothing) unless `lockToken` still holds it.
   */
  saveRefreshed(
    id: string,
    lockToken: string,
    refresh: ConnectionRefresh,
  ): Promise<ConnectionRecord | null>;
  /**
   * Sets `status = reauth_required` and releases the lock. Returns `null`
   * (and changes nothing) unless `lockToken` still holds it.
   */
  markReauthRequired(
    id: string,
    lockToken: string,
    now: Date,
  ): Promise<ConnectionRecord | null>;
  /** Releases the lock, if `lockToken` holds it. */
  releaseRefreshLock(id: string, lockToken: string): Promise<void>;
  /**
   * Active connections that at least one grant references, last refreshed
   * before `refreshedBefore`, oldest first.
   */
  listIdleConnections(query: {
    refreshedBefore: Date;
    limit: number;
  }): Promise<ConnectionRecord[]>;
}
