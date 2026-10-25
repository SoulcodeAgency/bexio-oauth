import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrations } from "./sql.js";

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

describe("migrations", () => {
  it("embeds exactly the files in sql/, in order (run `npm run sql:generate` if this fails)", async () => {
    const onDisk = readdirSync(SQL_DIR)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort()
      .map((name) => ({
        number: Number.parseInt(name.slice(0, 4), 10),
        name,
        sql: readFileSync(new URL(name, SQL_DIR), "utf8").replace(
          /\r\n/g,
          "\n",
        ),
      }));
    expect(onDisk.length).toBeGreaterThan(0);
    expect(await migrations()).toEqual(onDisk);
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
