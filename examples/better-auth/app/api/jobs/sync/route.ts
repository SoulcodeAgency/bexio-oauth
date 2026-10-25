import { isBexioOAuthError } from "@soulcode/bexio-oauth";
import { getBexio } from "@/lib/bexio";
import { isCronRequest } from "@/lib/cron";
import { optionalEnv } from "@/lib/env";

// A background job: no user session, only the owner id.
// GET /api/jobs/sync?owner=workspace:a  (Authorization: Bearer <CRON_SECRET>)
export async function GET(request: Request) {
  if (!isCronRequest(request)) return new Response(null, { status: 401 });
  const ownerId = new URL(request.url).searchParams.get("owner") ?? "";
  try {
    const { accessToken, grant } = await getBexio().getAccessToken({ ownerId });
    const api = optionalEnv("BEXIO_API_BASE_URL") ?? "https://api.bexio.com";
    const res = await fetch(`${api}/2.0/company_profile`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    const profile = (await res.json()) as { name: string }[];
    return Response.json({
      ok: res.ok,
      company: profile[0]?.name,
      grantId: grant.id,
    });
  } catch (error) {
    if (isBexioOAuthError(error)) {
      return Response.json({ ok: false, code: error.code }, { status: 409 });
    }
    throw error;
  }
}
