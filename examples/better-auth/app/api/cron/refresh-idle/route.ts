import { getBexio } from "@/lib/bexio";
import { idleFor, isCronRequest } from "@/lib/cron";

// Run on a schedule to keep idle connections inside Bexio's offline-session
// idle timeout (see idleFor for the demo default).
export async function GET(request: Request) {
  if (!isCronRequest(request)) return new Response(null, { status: 401 });
  return Response.json(await getBexio().refreshIdle({ idleFor: idleFor() }));
}
