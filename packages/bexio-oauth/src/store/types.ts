import type { Role } from "../permissions.js";

export type GrantStatus = "active" | "reauth_required";

/** A stored grant. Token fields hold JWE ciphertext, never plaintext. */
export interface GrantRecord {
  id: string;
  ownerId: string;
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

/** Insert, or overwrite the tokens of, the grant for (owner, company, user). */
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

export interface GrantRefresh {
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
  /** …or only if the grant was last refreshed before this instant (idle sweep). */
  refreshedBefore?: Date;
}

/**
 * Persistence for grants. Every method must be atomic on its own: the
 * library never needs multi-statement transactions.
 */
export interface GrantStore {
  upsertGrant(input: GrantUpsert): Promise<GrantRecord>;
  findGrants(query: {
    ownerId: string;
    companyId?: string;
    grantId?: string;
  }): Promise<GrantRecord[]>;
  getGrant(id: string): Promise<GrantRecord | null>;
  /**
   * Takes the refresh lock if the grant is active, not locked (or the lock
   * expired), and still matches the `accessExpiresBefore` / `refreshedBefore`
   * condition. Returns the locked row, or `null` if someone else holds the
   * lock or the grant no longer needs a refresh.
   */
  acquireRefreshLock(request: LockRequest): Promise<GrantRecord | null>;
  /**
   * Stores refreshed tokens, sets `lastRefreshedAt`, and releases the lock.
   * Returns `null` (and changes nothing) unless `lockToken` still holds it.
   */
  saveRefreshed(
    id: string,
    lockToken: string,
    refresh: GrantRefresh,
  ): Promise<GrantRecord | null>;
  /** Sets `status = reauth_required` and releases the lock, if `lockToken` holds it. */
  markReauthRequired(id: string, lockToken: string, now: Date): Promise<void>;
  /** Releases the lock, if `lockToken` holds it. */
  releaseRefreshLock(id: string, lockToken: string): Promise<void>;
  deleteGrant(id: string): Promise<void>;
  /** Active grants last refreshed before `refreshedBefore`, oldest first. */
  listIdleGrants(query: {
    refreshedBefore: Date;
    limit: number;
  }): Promise<GrantRecord[]>;
}
