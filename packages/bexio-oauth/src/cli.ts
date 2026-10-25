import { generateKey } from "./crypto.js";
import { migrations } from "./sql.js";

const HELP = `Usage: bexio-oauth <command>

Commands:
  sql [--from <n>]   Print the schema SQL (all migrations, or from migration <n> on)
  keygen             Print a new random 32-byte encryption key (base64url)
  help               Show this help
`;

export async function run(
  argv: string[],
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "sql": {
      let from = 1;
      if (rest[0] === "--from") {
        from = Number.parseInt(rest[1] ?? "", 10);
        if (!Number.isInteger(from) || from < 1) {
          err("--from needs a migration number, e.g. --from 2\n");
          return 1;
        }
      } else if (rest.length > 0) {
        err(HELP);
        return 1;
      }
      const selected = (await migrations()).filter((m) => m.number >= from);
      out(selected.map((m) => `-- ${m.name}\n${m.sql.trimEnd()}\n`).join("\n"));
      return 0;
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
