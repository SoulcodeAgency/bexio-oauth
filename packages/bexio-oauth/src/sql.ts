import { readdir, readFile } from "node:fs/promises";

export interface Migration {
  /** Sequence number, from the file name prefix (`0001_…` → 1). */
  number: number;
  name: string;
  sql: string;
}

// `sql/` sits next to `src/` and `dist/` in the package.
const SQL_DIR = new URL("../sql/", import.meta.url);

/** The schema migrations shipped with this version, in order. */
export async function migrations(): Promise<Migration[]> {
  const files = (await readdir(SQL_DIR))
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  return Promise.all(
    files.map(async (name) => ({
      number: Number.parseInt(name.slice(0, 4), 10),
      name,
      sql: await readFile(new URL(name, SQL_DIR), "utf8"),
    })),
  );
}
