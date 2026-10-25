import type { Duration } from "@soulcode/bexio-oauth";
import { getBexio } from "@/lib/bexio";
import { isCronRequest } from "@/lib/cron";

// Run on a schedule (e.g. weekly) to keep idle grants inside Bexio's
// offline-session idle timeout.
export async function GET(request: Request) {
  if (!isCronRequest(request)) return new Response(null, { status: 401 });
  const idleFor = (process.env.BEXIO_IDLE_FOR ?? "7d") as Duration;
  return Response.json(await getBexio().refreshIdle({ idleFor }));
}
