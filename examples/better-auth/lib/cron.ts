import type { Duration } from "@soulcode/bexio-oauth";
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

/**
 * How long a connection must sit unrefreshed before the refreshIdle cron
 * refreshes it. The demo default is a minute, so a manual call shows
 * refreshes; a real app uses days (e.g. "7d").
 */
export const idleFor = (): Duration =>
  (process.env.BEXIO_IDLE_FOR ?? "1m") as Duration;

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `idleFor()` in milliseconds (for the page's countdown). */
export function idleForMs(): number {
  const value = idleFor();
  if (typeof value === "number") return value;
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (!match) throw new Error(`BEXIO_IDLE_FOR "${value}" is not a duration`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}
