import { BexioOAuthError } from "./errors.js";

const RETURN_TO_BASE = "https://return-to.invalid";

/**
 * Only same-origin relative paths: blocks open redirects via `returnTo`.
 * Parsed with the URL parser (the same one the redirect will go through), so
 * tricks like `/\t/evil.example` are caught, and normalized to path+query+hash.
 * Returns `fallback` for an empty value; throws `invalid_config` otherwise.
 */
export function safeReturnTo(
  value: string | undefined,
  fallback: string,
): string {
  if (!value) return fallback;
  const invalid = () =>
    new BexioOAuthError(
      "invalid_config",
      "returnTo must be a relative path like /settings",
    );
  // eslint-disable-next-line no-control-regex
  if (!value.startsWith("/") || /[\u0000-\u001f\\]/.test(value))
    throw invalid();
  let url: URL;
  try {
    url = new URL(value, RETURN_TO_BASE);
  } catch {
    throw invalid();
  }
  if (url.origin !== RETURN_TO_BASE) throw invalid();
  // Dot segments can collapse to "//host" (e.g. "/.//evil.example"), which a
  // browser reads as protocol-relative: check the normalized result too.
  if (url.pathname.startsWith("//")) throw invalid();
  return `${url.pathname}${url.search}${url.hash}`;
}
