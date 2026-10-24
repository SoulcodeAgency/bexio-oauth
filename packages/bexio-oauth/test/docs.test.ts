import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

const guide = await readFile(
  new URL("../../../docs/integration.md", import.meta.url),
  "utf8",
);
const reference = guide.slice(guide.indexOf("## 16. API reference"));
const indexSource = await readFile(
  new URL("../src/index.ts", import.meta.url),
  "utf8",
);

/** Every name exported from src/index.ts, values and types alike. */
function exportedNames(source: string): string[] {
  const names = new Set<string>();
  for (const block of source.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
    for (const raw of block[1]!.split(",")) {
      const name = raw
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop()!
        .trim();
      if (name) names.add(name);
    }
  }
  return [...names];
}

describe("docs/integration.md", () => {
  it("lists every export in §16", () => {
    const names = exportedNames(indexSource);
    expect(names.length).toBeGreaterThan(20);
    const missing = names.filter((n) => !reference.includes(`\`${n}\``));
    expect(missing).toEqual([]);
  });

  it("documents every runtime export and every error code", () => {
    for (const name of Object.keys(api))
      expect(reference).toContain(`\`${name}\``);
    const codes = [
      "state_mismatch",
      "owner_mismatch",
      "access_denied",
      "invalid_callback",
      "idp_error",
      "not_connected",
      "ambiguous_grant",
      "reauth_required",
      "decryption_failed",
      "invalid_config",
    ] satisfies api.BexioOAuthErrorCode[];
    const errors = guide.slice(
      guide.indexOf("## 11. Errors"),
      guide.indexOf("## 12."),
    );
    for (const code of codes) expect(errors).toContain(`\`${code}\``);
  });

  it("documents every client method", () => {
    const methods = Object.keys(
      api.createBexioOAuth({
        clientId: "c",
        clientSecret: "s",
        redirectUri: "https://app.example.com/cb",
        keys: { current: "k", keys: { k: api.generateKey() } },
        store: api.memoryStore(),
      }),
    );
    for (const method of methods) expect(reference).toContain(`\`${method}\``);
  });
});
