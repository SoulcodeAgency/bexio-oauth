import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * Job and cron routes require `Authorization: Bearer <CRON_SECRET>`.
 * Compared in constant time on fixed-length digests, so neither the secret's
 * length nor the position of the first differing byte leaks through timing.
 */
export function isCronRequest(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(digest(presented), digest(env("CRON_SECRET")));
}

const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest();
