import { getBexio } from "@/lib/bexio";
import { getUser } from "@/lib/supabase/server";

// The redirect URI registered at Bexio. The owner recorded at start must be
// the signed-in user; anything else (signed out, another user) redirects with
// bexio_error=owner_mismatch.
export async function GET(request: Request) {
  const user = await getUser();
  return getBexio().callback(request, {
    authorizeOwner: (ownerId) => user !== null && ownerId === user.id,
  });
}
