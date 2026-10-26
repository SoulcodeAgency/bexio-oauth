import { describe, expect, it } from "vitest";
import { run } from "./cli.js";

async function cli(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await run(
    argv,
    (s) => (stdout += s),
    (s) => (stderr += s),
  );
  return { code, stdout, stderr };
}

describe("cli", () => {
  it("sql prints every migration in order", async () => {
    const { code, stdout } = await cli("sql");
    expect(code).toBe(0);
    expect(stdout).toContain("-- 0001_bexio_oauth.sql");
    expect(stdout).toContain("CREATE TABLE IF NOT EXISTS bexio_connections");
  });

  it("sql --from <n> skips earlier migrations", async () => {
    expect((await cli("sql", "--from", "1")).stdout).toContain(
      "0001_bexio_oauth.sql",
    );
    expect((await cli("sql", "--from", "2")).stdout).not.toContain(
      "0001_bexio_oauth.sql",
    );
    expect((await cli("sql", "--from", "x")).code).toBe(1);
  });

  it("keygen prints a 32-byte base64url key", async () => {
    const { code, stdout } = await cli("keygen");
    expect(code).toBe(0);
    expect(Buffer.from(stdout.trim(), "base64url")).toHaveLength(32);
  });

  it("prints help and fails on unknown commands", async () => {
    expect((await cli("help")).stdout).toContain("Usage");
    expect((await cli("nope")).code).toBe(1);
  });
});
