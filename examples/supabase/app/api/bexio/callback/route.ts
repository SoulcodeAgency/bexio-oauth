import { getBexio } from "@/lib/bexio";
import { getUser } from "@/lib/supabase/server";

// The redirect URI registered at Bexio. ownerId comes from the session again;
// the library checks it equals the one used at start.
export async function GET(request: Request) {
  const user = await getUser();
  return getBexio().callback(request, { ownerId: user?.id ?? "" });
}
