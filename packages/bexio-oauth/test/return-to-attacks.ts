/** `returnTo` values that would redirect off-site; all must be refused. */
export const OFF_SITE_RETURN_TO = [
  "https://evil.example",
  "//evil.example",
  "/\\evil.example",
  "/\t/evil.example",
  "/\n/evil.example",
  "/\r/evil.example",
  "/.//evil.example",
  "/x/..//evil.example",
];
