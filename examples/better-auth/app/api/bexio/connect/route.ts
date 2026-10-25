import { canManageOwner, getBexio, workspaceOwner } from "@/lib/bexio";
import { getSessionFor } from "@/lib/session";

// GET /api/bexio/connect?workspace=a: connect Bexio for a workspace.
export async function GET(request: Request) {
  const session = await getSessionFor(request);
  if (!session) return new Response("Sign in first", { status: 401 });
  const ownerId = workspaceOwner(
    new URL(request.url).searchParams.get("workspace") ?? "",
  );
  if (!canManageOwner(session.user, ownerId)) {
    return new Response("Not allowed", { status: 403 });
  }
  return getBexio().start({ ownerId, returnTo: "/" });
}
