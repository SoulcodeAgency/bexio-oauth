import type { JWTPayload } from "jose";
import type { TokenCipher } from "./crypto.js";

/** The encrypted, short-lived cookie that carries the Connect flow's state. */
export const FLOW_COOKIE = "bexio_oauth_flow";
export const FLOW_TTL_SECONDS = 600;

export interface FlowState extends JWTPayload {
  /** state */ s: string;
  /** PKCE verifier */ v: string;
  /** nonce */ n: string;
  /** ownerId */ o: string;
  /** returnTo */ r: string;
}

/** The value of cookie `name` in the request's `Cookie` header, or `null`. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name)
      return part.slice(index + 1).trim();
  }
  return null;
}

/**
 * The `Set-Cookie` value for the flow cookie, scoped to the callback path.
 * `Secure` whenever the redirect URI is https. `("", 0)` deletes it.
 */
export function flowCookie(
  redirectUri: URL,
  value: string,
  maxAge: number,
): string {
  const parts = [
    `${FLOW_COOKIE}=${value}`,
    `Path=${redirectUri.pathname}`,
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (redirectUri.protocol === "https:") parts.push("Secure");
  return parts.join("; ");
}

export function sealFlow(
  cipher: TokenCipher,
  flow: FlowState,
  now: Date,
): Promise<string> {
  return cipher.seal(flow, FLOW_TTL_SECONDS, now);
}

/** The request's flow state, or `null` when the cookie is missing, invalid or expired. */
export async function readFlow(
  cipher: TokenCipher,
  request: Request,
  now: Date,
): Promise<FlowState | null> {
  const sealed = readCookie(request, FLOW_COOKIE);
  if (!sealed) return null;
  return (await cipher.unseal(sealed, now)) as FlowState | null;
}
