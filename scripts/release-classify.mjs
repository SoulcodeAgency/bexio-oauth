// Decides whether a release PR may merge itself: only when every commit since
// the last release was made by Dependabot and at least one is a `fix(deps)`
// (a runtime-dependency update). Feature releases keep their human gate.
//
// Only commits that touch the published package count: those are the ones
// release-please puts into the release.
//
// Usage: node scripts/release-classify.mjs <last-release-tag>   (in a full clone)
// Prints "auto" or "manual: <reason>".

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DEPENDABOT = "dependabot[bot]";

/** @param {{ author: string | null, message: string }[]} commits */
export function classifyRelease(commits) {
  if (commits.length === 0)
    return { auto: false, reason: "no commits since the last release" };
  const human = commits.find((c) => c.author !== DEPENDABOT);
  if (human) {
    const subject = human.message.split("\n")[0];
    return {
      auto: false,
      reason: `contains a commit not made by Dependabot: "${subject}"`,
    };
  }
  if (
    commits.some(
      (c) =>
        /^[a-z]+(\([^)]*\))?!:/.test(c.message) ||
        /BREAKING CHANGE:/.test(c.message),
    )
  ) {
    return { auto: false, reason: "contains a breaking change" };
  }
  if (!commits.some((c) => /^fix\(deps\):/.test(c.message))) {
    return { auto: false, reason: "no runtime dependency fix in this release" };
  }
  return { auto: true, reason: "dependency fixes only" };
}

/** Commits since `tag` that touch the published package. */
export function packageCommitsSince(tag) {
  const log = execFileSync(
    "git",
    [
      "log",
      `${tag}..HEAD`,
      "--format=%an%x1f%B%x1e",
      "--",
      "packages/bexio-oauth",
    ],
    { encoding: "utf8" },
  );
  return log
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [author, message = ""] = entry.split("\x1f");
      return { author, message: message.trim() };
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  if (!tag) {
    console.error(
      "usage: node scripts/release-classify.mjs <last-release-tag>",
    );
    process.exit(2);
  }
  const result = classifyRelease(packageCommitsSince(tag));
  console.log(result.auto ? "auto" : `manual: ${result.reason}`);
}
