import { BexioOAuthError } from "./errors.js";

/** Milliseconds, or a string like `"30s"`, `"15m"`, `"12h"`, `"7d"`. */
export type Duration = number | `${number}${"s" | "m" | "h" | "d"}`;

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function toMs(value: Duration, name: string): number {
  if (typeof value === "number") {
    if (Number.isFinite(value) && value > 0) return value;
  } else {
    const match = /^(\d+(?:\.\d+)?)([smhd])$/.exec(value);
    if (match)
      return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  }
  throw new BexioOAuthError(
    "invalid_config",
    `${name} must be a positive number of milliseconds or a string like "7d"`,
  );
}
