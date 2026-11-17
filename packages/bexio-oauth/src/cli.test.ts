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
    expect(stdout).toContain(
      "CREATE TABLE IF NOT EXISTS bexio_oauth.bexio_connections",
    );
    expect(stdout).toContain("CREATE ROLE bexio_store LOGIN");
    expect(stdout).not.toContain("bexio_token");
  });

  it("sql --schema --store-role --token-role prints the SQL with those names", async () => {
    const { code, stdout } = await cli(
      "sql",
      "--schema",
      "app_tokens",
      "--store-role",
      "app_store",
      "--token-role",
      "app_token",
    );
    expect(code).toBe(0);
    await expect(stdout).toMatchFileSnapshot(
      "__snapshots__/sql-custom-names.sql",
    );
  });

  it("sql --from <n> skips earlier migrations, with the same names", async () => {
    expect((await cli("sql", "--from", "1")).stdout).toContain(
      "0001_bexio_oauth.sql",
    );
    expect(
      (await cli("sql", "--from", "2", "--schema", "app_tokens")).stdout,
    ).not.toContain("0001_bexio_oauth.sql");
    expect((await cli("sql", "--from", "x")).code).toBe(1);
    expect((await cli("sql", "--from", "2x")).code).toBe(1);
  });

  it("sql fails on bad names and unknown options", async () => {
    const bad = await cli("sql", "--schema", "public");
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("dedicated schema");
    expect((await cli("sql", "--role", "x")).code).toBe(1);
    expect((await cli("sql", "--schema")).code).toBe(1);
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
