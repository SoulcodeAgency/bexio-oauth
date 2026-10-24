export type Role = "admin" | "member";

interface PermissionsResponse {
  permissions?: { admin?: { activation?: unknown } };
}

/** `admin` when Bexio reports `permissions.admin.activation === "enabled"`. */
export function roleFromPermissions(body: unknown): Role {
  const activation = (body as PermissionsResponse | null)?.permissions?.admin
    ?.activation;
  return activation === "enabled" ? "admin" : "member";
}

/**
 * Reads the user's role from `GET /3.0/permissions`. Best effort: returns
 * `null` on any failure so callers keep the previous role.
 */
export async function fetchRole(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  accessToken: string,
): Promise<Role | null> {
  try {
    const res = await fetchImpl(new URL("/3.0/permissions", apiBaseUrl), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      // Runs while the refresh lock is held: never wait long.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return roleFromPermissions(await res.json());
  } catch {
    return null;
  }
}
