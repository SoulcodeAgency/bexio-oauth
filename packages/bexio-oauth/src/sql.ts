import { MIGRATIONS } from "./migrations.generated.js";

export interface Migration {
  /** Sequence number, from the file name prefix (`0001_…` → 1). */
  number: number;
  name: string;
  sql: string;
}

/**
 * The schema migrations shipped with this version, in order.
 *
 * The SQL is embedded in the build (generated from `sql/*.sql`), not read from
 * disk, so this works unchanged when a bundler inlines the library.
 */
export async function migrations(): Promise<Migration[]> {
  return MIGRATIONS.map((m) => ({ ...m }));
}
