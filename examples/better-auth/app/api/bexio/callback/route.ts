import { getBexio, isWorkspaceOwner } from "@/lib/bexio";
import { getSessionFor } from "@/lib/session";

// The redirect URI registered at Bexio. One URL serves every workspace, so the
// owner comes from the flow cookie and is approved here (connection-CSRF check).
export async function GET(request: Request) {
  const session = await getSessionFor(request);
  return getBexio().callback(request, {
    authorizeOwner: (ownerId) => session !== null && isWorkspaceOwner(ownerId),
  });
}
