import { env } from "./env";

/** Job and cron routes require `Authorization: Bearer <CRON_SECRET>`. */
export function isCronRequest(request: Request): boolean {
  return (
    request.headers.get("authorization") === `Bearer ${env("CRON_SECRET")}`
  );
}
