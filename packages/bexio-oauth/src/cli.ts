import { parseArgs } from "node:util";
import { generateKey } from "./crypto.js";
import { isBexioOAuthError } from "./errors.js";
import { migrations } from "./sql.js";

const HELP = `Usage: bexio-oauth <command>

Commands:
  sql [options]   Print the schema SQL: a dedicated schema, its tables, and
                  the login role(s) that may use them
    --from <n>             only migration <n> onwards (for upgrades)
    --schema <name>        schema for the tables (default bexio_oauth)
    --store-role <name>    role for postgresStore's connection (default bexio_store)
    --token-role <name>    also create a narrower role for runtimes that only
                           use tokens (conventionally bexio_token)
  keygen          Print a new random 32-byte encryption key (base64url)
  help            Show this help
`;

export async function run(
  argv: string[],
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "sql": {
      let values: Record<string, string | undefined>;
      try {
        ({ values } = parseArgs({
          args: rest,
          options: {
            from: { type: "string" },
            schema: { type: "string" },
            "store-role": { type: "string" },
            "token-role": { type: "string" },
          },
        }));
      } catch (error) {
        err(`${(error as Error).message}\n\n${HELP}`);
        return 1;
      }
      const from = values.from === undefined ? 1 : Number(values.from);
      if (!Number.isInteger(from) || from < 1) {
        err("--from needs a migration number, e.g. --from 2\n");
        return 1;
      }
      try {
        const selected = (
          await migrations({
            schema: values.schema,
            storeRole: values["store-role"],
            tokenRole: values["token-role"],
          })
        ).filter((m) => m.number >= from);
        out(
          selected.map((m) => `-- ${m.name}\n${m.sql.trimEnd()}\n`).join("\n"),
        );
        return 0;
      } catch (error) {
        if (!isBexioOAuthError(error)) throw error;
        err(`${error.message}\n`);
        return 1;
      }
    }
    case "keygen":
      out(`${generateKey()}\n`);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return 0;
    default:
      err(`Unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}
