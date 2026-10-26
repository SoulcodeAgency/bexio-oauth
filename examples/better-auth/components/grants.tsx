import { isBexioOAuthError, type Grant } from "@soulcode/bexio-oauth";
import { disconnect, testTool } from "@/app/actions";
import { getBexio } from "@/lib/bexio";
import { optionalEnv } from "@/lib/env";
import { idleForMs } from "@/lib/cron";
import { hasSavedToken, testToolsEnabled } from "@/lib/test-tools";
import { IdleCountdown } from "./idle-countdown";

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

/** Test tools for this grant's connection (lib/test-tools.ts). */
function TestTools({ ownerId, grant }: { ownerId: string; grant: Grant }) {
  const tools: [tool: string, label: string][] = [
    ["expire", "Expire access token"],
    ["revoke", "Revoke at Bexio"],
    ["save", "Save token"],
  ];
  if (hasSavedToken(grant.connectionId))
    tools.push(["revoke-saved", "Revoke saved token"]);
  return (
    <div data-testid="test-tools">
      <small>Test tools: </small>
      {tools.map(([tool, label]) => (
        <form key={tool} action={testTool} style={{ display: "inline" }}>
          <input type="hidden" name="ownerId" value={ownerId} />
          <input type="hidden" name="connectionId" value={grant.connectionId} />
          <input type="hidden" name="tool" value={tool} />
          <button data-testid={`tool-${tool}`}>{label}</button>
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
    return <p data-testid={`grants-${ownerId}`}>Not connected.</p>;
  return (
    <ul data-testid={`grants-${ownerId}`}>
      {await Promise.all(
        grants.map(async (g) => {
          const result =
            g.status === "active" ? await companyName(g) : "Reconnect required";
          return (
            <li key={g.id} data-testid="grant" data-status={g.status}>
              <strong>{g.companyName}</strong> ({g.role}) · {g.userName} ·{" "}
              <span data-testid="api-result">{result}</span>{" "}
              {result === "Reconnect required" && (
                <a
                  data-testid="reconnect"
                  href={connectHref}
                  title={`Connect Bexio again and pick ${g.companyName ?? "the same company"}`}
                >
                  Reconnect
                </a>
              )}{" "}
              <form action={disconnect} style={{ display: "inline" }}>
                <input type="hidden" name="ownerId" value={ownerId} />
                <input type="hidden" name="grantId" value={g.id} />
                <button data-testid="disconnect">Disconnect</button>
              </form>
              {testToolsEnabled() && <TestTools ownerId={ownerId} grant={g} />}
            </li>
          );
        }),
      )}
    </ul>
  );
}
