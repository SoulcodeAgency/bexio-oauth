import { isBexioOAuthError, type Grant } from "@soulcode/bexio-oauth";
import { disconnect } from "@/app/actions";
import { getBexio } from "@/lib/bexio";
import { optionalEnv } from "@/lib/env";

type ApiCheck =
  | { state: "ok"; label: string; company: string }
  | { state: "reconnect" | "error"; label: string };

/** A sample API call with the grant's token, to show it works. */
async function checkApi(grant: Grant): Promise<ApiCheck> {
  if (grant.status !== "active")
    return { state: "reconnect", label: "Reconnect required" };
  try {
    const { accessToken } = await getBexio().getAccessToken({
      ownerId: grant.ownerId,
      grantId: grant.id,
    });
    const api = optionalEnv("BEXIO_API_BASE_URL") ?? "https://api.bexio.com";
    const res = await fetch(`${api}/2.0/company_profile`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) return { state: "error", label: `API error ${res.status}` };
    const [profile] = (await res.json()) as { name: string }[];
    return { state: "ok", label: "API OK", company: profile?.name ?? "" };
  } catch (error) {
    if (isBexioOAuthError(error, "reauth_required"))
      return { state: "reconnect", label: "Reconnect required" };
    throw error;
  }
}

export async function Grants({ ownerId }: { ownerId: string }) {
  const grants = await getBexio().listGrants({ ownerId });
  if (grants.length === 0)
    return (
      <p className="empty" data-testid="grants">
        Not connected.
      </p>
    );
  return (
    <ul className="grants" data-testid="grants">
      {await Promise.all(
        grants.map(async (g) => {
          const api = await checkApi(g);
          return (
            <li
              key={g.id}
              className="grant"
              data-testid="grant"
              data-status={g.status}
              data-state={api.state}
            >
              <div className="grant-main">
                <div className="who">
                  <strong>{g.companyName}</strong>
                  <span className="role">{g.role}</span>
                  <small>{g.userName}</small>
                </div>
                <span
                  className="pill"
                  data-testid="api-result"
                  data-company={api.state === "ok" ? api.company : undefined}
                >
                  {api.label}
                </span>
                {api.state === "reconnect" && (
                  <a
                    className="button primary"
                    data-testid="reconnect"
                    href="/api/bexio/connect"
                  >
                    Reconnect
                  </a>
                )}
                <form action={disconnect}>
                  <input type="hidden" name="grantId" value={g.id} />
                  <button data-testid="disconnect">Disconnect</button>
                </form>
              </div>
            </li>
          );
        }),
      )}
    </ul>
  );
}
