// Fails if the published tarball would contain anything but the build output,
// the SQL migrations and the standard package files.
import { execSync } from "node:child_process";

const out = execSync("npm pack --dry-run --json -w @soulcode/bexio-oauth", {
  encoding: "utf8",
});
const [{ files }] = JSON.parse(out);
const allowed =
  /^(dist\/.+|sql\/\d{4}_.+\.sql|README\.md|LICENSE|package\.json)$/;
const unexpected = files
  .map((f) => f.path)
  .filter((p) => !allowed.test(p) || /\.test\./.test(p));
if (unexpected.length > 0) {
  console.error(
    `Unexpected files in the package:\n  ${unexpected.join("\n  ")}`,
  );
  process.exit(1);
}
for (const required of [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/bin.js",
  "dist/migrations.generated.js",
  "sql/0001_bexio_grants.sql",
]) {
  if (!files.some((f) => f.path === required)) {
    console.error(`Missing from the package: ${required}`);
    process.exit(1);
  }
}
console.log(`Package contents OK (${files.length} files).`);
