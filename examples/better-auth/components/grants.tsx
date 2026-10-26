import { isBexioOAuthError, type Grant } from "@soulcode/bexio-oauth";
import { disconnect, testTool } from "@/app/actions";
import { getBexio } from "@/lib/bexio";
import { idleForMs } from "@/lib/cron";
import { optionalEnv } from "@/lib/env";
import { hasSavedToken, testToolsEnabled } from "@/lib/test-tools";
import { IdleCountdown } from "./idle-countdown";

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

/** Test tools for this grant's connection (lib/test-tools.ts). */
function TestTools({ ownerId, grant }: { ownerId: string; grant: Grant }) {
  const tools: [tool: string, label: string, title: string][] = [
    ["expire", "Expire", "Expire the access token: the next load refreshes"],
    ["revoke", "Revoke", "Revoke the refresh token at Bexio"],
    ["save", "Save token", "Keep the refresh token to revoke it later"],
  ];
  if (hasSavedToken(grant.connectionId))
    tools.push([
      "revoke-saved",
      "Revoke saved",
      "Revoke the saved (now stale) refresh token",
    ]);
  return (
    <div className="tools" data-testid="test-tools">
      {tools.map(([tool, label, title]) => (
        <form key={tool} action={testTool}>
          <input type="hidden" name="ownerId" value={ownerId} />
          <input type="hidden" name="connectionId" value={grant.connectionId} />
          <input type="hidden" name="tool" value={tool} />
          <button data-testid={`tool-${tool}`} title={title}>
            {label}
          </button>
        </form>
      ))}
      {grant.status === "active" && (
        <IdleCountdown
          idleAt={new Date(
            grant.lastRefreshedAt.getTime() + idleForMs(),
          ).toISOString()}
        />
      )}
    </div>
  );
}

/**
 * The owner's grants. `connectHref` starts Connect Bexio for this owner; it
 * is how a "Reconnect required" grant gets new tokens.
 */
export async function Grants({
  ownerId,
  connectHref,
}: {
  ownerId: string;
  connectHref: string;
}) {
  const grants = await getBexio().listGrants({ ownerId });
  if (grants.length === 0)
    return (
      <p className="empty" data-testid={`grants-${ownerId}`}>
        Not connected.
      </p>
    );
  return (
    <ul className="grants" data-testid={`grants-${ownerId}`}>
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
                    href={connectHref}
                    title={`Pick ${g.companyName ?? "the same company"} at Bexio`}
                  >
                    Reconnect
                  </a>
                )}
                <form action={disconnect}>
                  <input type="hidden" name="ownerId" value={ownerId} />
                  <input type="hidden" name="grantId" value={g.id} />
                  <button data-testid="disconnect">Disconnect</button>
                </form>
              </div>
              {testToolsEnabled() && <TestTools ownerId={ownerId} grant={g} />}
            </li>
          );
        }),
      )}
    </ul>
  );
}
