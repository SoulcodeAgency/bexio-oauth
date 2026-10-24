import { isBexioOAuthError, type Grant } from "@soulcode/bexio-oauth";
import { disconnect } from "@/app/actions";
import { getBexio } from "@/lib/bexio";
import { optionalEnv } from "@/lib/env";

/** A sample API call with the grant's token, to show it works. */
async function companyName(grant: Grant): Promise<string> {
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
    if (!res.ok) return `API call failed: HTTP ${res.status}`;
    const [profile] = (await res.json()) as { name: string }[];
    return `API call OK: ${profile?.name}`;
  } catch (error) {
    if (isBexioOAuthError(error, "reauth_required"))
      return "Reconnect required";
    throw error;
  }
}

export async function Grants({ ownerId }: { ownerId: string }) {
  const grants = await getBexio().listGrants({ ownerId });
  if (grants.length === 0)
    return <p data-testid={`grants-${ownerId}`}>Not connected.</p>;
  return (
    <ul data-testid={`grants-${ownerId}`}>
      {await Promise.all(
        grants.map(async (g) => (
          <li key={g.id} data-testid="grant" data-status={g.status}>
            <strong>{g.companyName}</strong> ({g.role}) · {g.userName} ·{" "}
            <span data-testid="api-result">
              {g.status === "active"
                ? await companyName(g)
                : "Reconnect required"}
            </span>{" "}
            <form action={disconnect} style={{ display: "inline" }}>
              <input type="hidden" name="ownerId" value={ownerId} />
              <input type="hidden" name="grantId" value={g.id} />
              <button data-testid="disconnect">Disconnect</button>
            </form>
          </li>
        )),
      )}
    </ul>
  );
}
