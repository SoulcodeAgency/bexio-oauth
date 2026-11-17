import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "./migrations.generated.js";
import { migrations, renameDefaults } from "./sql.js";

const pkg = new URL("../", import.meta.url);
const SQL_DIR = new URL("sql/", pkg);

/** Non-test files under `dir` with one of the given extensions, recursively. */
function files(dir: URL, ext: RegExp): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => ext.test(f) && !/\.test\./.test(f));
}

// Anything that resolves files relative to the module breaks once a bundler
// (Next.js inlines server dependencies by default) moves the code elsewhere.
const FILE_ACCESS =
  /import\.meta|node:fs|["']fs["']|readdir|readFile|__dirname|__filename|createRequire|require\(/;

const read = (name: string) =>
  readFileSync(new URL(name, SQL_DIR), "utf8").replace(/\r\n/g, "\n");

const CUSTOM = {
  schema: "app_tokens",
  storeRole: "app_store",
  tokenRole: "app_token",
};

describe("migrations", () => {
  it("embeds exactly the files in sql/, in order (run `npm run sql:generate` if this fails)", async () => {
    const files = readdirSync(SQL_DIR);
    const onDisk = files
      .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
      .sort()
      .map((name) => {
        const tokenRole = name.replace(/\.sql$/, ".token-role.sql");
        return {
          number: Number.parseInt(name.slice(0, 4), 10),
          name,
          sql: read(name),
          ...(files.includes(tokenRole)
            ? { tokenRoleSql: read(tokenRole) }
            : {}),
        };
      });
    expect(onDisk.length).toBeGreaterThan(0);
    expect(MIGRATIONS).toEqual(onDisk);
    // With the default names and no token role, exactly the main files.
    expect(await migrations()).toEqual(
      onDisk.map(({ number, name, sql }) => ({ number, name, sql })),
    );
  });

  it("appends a migration's token-role part only when tokenRole is set", async () => {
    const plain = await migrations();
    const withToken = await migrations({ tokenRole: "bexio_token" });
    for (const [i, m] of MIGRATIONS.entries()) {
      // Without a token role, no SQL may mention one: the role wouldn't exist.
      expect(m.sql).not.toContain("bexio_token");
      if (!m.tokenRoleSql) {
        expect(withToken[i]).toEqual(plain[i]);
        continue;
      }
      expect(m.tokenRoleSql).toContain("bexio_token");
      expect(withToken[i]!.sql.startsWith(plain[i]!.sql.trimEnd())).toBe(true);
    }
    expect(withToken[0]!.sql).toContain("CREATE ROLE bexio_token LOGIN");
  });

  it("names every table with its schema, so no migration depends on search_path", () => {
    for (const m of MIGRATIONS) {
      for (const sql of [m.sql, m.tokenRoleSql ?? ""]) {
        for (const [, prefix] of sql.matchAll(
          /(\S*?)\bbexio_(?:connections|grants)\b/g,
        ))
          expect(prefix).toMatch(/bexio_oauth\.$/);
      }
    }
  });

  it("replaces every default name with the caller's, quoted", async () => {
    const sql = (await migrations(CUSTOM)).map((m) => m.sql).join("\n");
    expect(sql).not.toMatch(/\bbexio_(?:oauth|store|token)\b/);
    expect(sql).toContain('CREATE SCHEMA IF NOT EXISTS "app_tokens";');
    expect(sql).toContain("WHERE rolname = 'app_store'");
    expect(sql).toContain('CREATE ROLE "app_store" LOGIN NOINHERIT;');
    expect(sql).toContain('TO "app_token"');
  });

  it("replaces names in string literals as literals, for every default name", () => {
    const names = {
      bexio_oauth: "app_tokens",
      bexio_store: "app_store",
      bexio_token: "app_token",
    };
    expect(
      renameDefaults(
        "SELECT FROM pg_namespace WHERE nspname = 'bexio_oauth'; SELECT 'bexio_store', 'bexio_token';",
        names,
      ),
    ).toBe(
      "SELECT FROM pg_namespace WHERE nspname = 'app_tokens'; SELECT 'app_store', 'app_token';",
    );
  });

  it("names each policy after its role, so other roles' policies survive a re-run", async () => {
    const [m] = await migrations({ ...CUSTOM });
    expect(m!.sql).toContain('CREATE POLICY "app_store" ON "app_tokens"');
    expect(m!.sql).toContain('CREATE POLICY "app_token" ON "app_tokens"');
    expect(m!.sql).not.toMatch(/CREATE POLICY (?!"app_)/);
    expect(m!.sql).not.toMatch(/DROP POLICY IF EXISTS (?!"app_)/);
  });

  it("replaces in one pass: a name that equals another default isn't replaced again", async () => {
    const [m] = await migrations({ schema: "bexio_store", storeRole: "x" });
    expect(m!.sql).toContain('CREATE SCHEMA IF NOT EXISTS "bexio_store";');
    expect(m!.sql).toContain('GRANT USAGE ON SCHEMA "bexio_store" TO "x";');
  });

  it("refuses names that aren't safe identifiers, shared schemas, and one role for both", async () => {
    for (const options of [
      { schema: "public" },
      { schema: "information_schema" },
      { schema: "pg_temp" },
      { schema: "Tokens" },
      { storeRole: "store'; DROP ROLE postgres; --" },
      { storeRole: "pg_monitor" },
      { storeRole: "public" },
      { tokenRole: "public" },
      { storeRole: "none" },
      { tokenRole: "current_user" },
      { storeRole: "postgres" },
      { storeRole: "authenticated" },
      { tokenRole: "service_role" },
      { tokenRole: "" },
      { storeRole: "same", tokenRole: "same" },
    ]) {
      await expect(migrations(options)).rejects.toMatchObject({
        code: "invalid_config",
      });
    }
  });

  it("returns fresh objects on every call", async () => {
    const [first] = await migrations();
    first!.sql = "changed";
    expect((await migrations())[0]!.sql).not.toBe("changed");
  });

  it("runtime sources never touch the file system", () => {
    const src = new URL("src/", pkg);
    const offenders = files(src, /\.ts$/).filter((f) =>
      FILE_ACCESS.test(readFileSync(new URL(f, src), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  const dist = new URL("dist/", pkg);
  it.skipIf(!existsSync(dist))(
    "built dist/ never touches the file system",
    () => {
      const offenders = files(dist, /\.js$/).filter((f) =>
        FILE_ACCESS.test(readFileSync(new URL(f, dist), "utf8")),
      );
      expect(offenders).toEqual([]);
    },
  );
});
