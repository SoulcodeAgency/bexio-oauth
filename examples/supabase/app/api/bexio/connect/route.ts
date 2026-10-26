import { getBexio } from "@/lib/bexio";
import { getUser } from "@/lib/supabase/server";

// Connect Bexio for the signed-in Supabase user (ownerId = auth.users.id).
export async function GET() {
  const user = await getUser();
  if (!user) return new Response("Sign in first", { status: 401 });
  return getBexio().start({ ownerId: user.id, returnTo: "/" });
}
