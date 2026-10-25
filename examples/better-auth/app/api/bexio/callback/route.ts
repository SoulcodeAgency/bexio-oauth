import { canManageOwner, getBexio } from "@/lib/bexio";
import { getSessionFor } from "@/lib/session";

// The redirect URI registered at Bexio. One URL serves every workspace, so the
// owner comes from the flow cookie and the signed-in user must be allowed to
// manage it (connection-CSRF protection).
export async function GET(request: Request) {
  const session = await getSessionFor(request);
  return getBexio().callback(request, {
    authorizeOwner: (ownerId) => canManageOwner(session?.user, ownerId),
  });
}
