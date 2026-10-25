import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRelease, DEPENDABOT } from "./release-classify.mjs";

const dep = (message) => ({ author: DEPENDABOT, message });

test("dependency fixes only → auto", () => {
  assert.equal(
    classifyRelease([dep("fix(deps): bump jose from 6.2.13 to 6.2.14")]).auto,
    true,
  );
  assert.equal(
    classifyRelease([
      dep("fix(deps): bump jose from 6.2.13 to 6.2.14"),
      dep("chore(deps): bump vitest"),
    ]).auto,
    true,
  );
});

test("a feature or a human fix → manual", () => {
  assert.equal(
    classifyRelease([
      dep("fix(deps): bump jose"),
      { author: "ada", message: "feat: add x" },
    ]).auto,
    false,
  );
  assert.equal(
    classifyRelease([
      { author: "ada", message: "fix(deps): bump jose by hand" },
    ]).auto,
    false,
  );
  assert.equal(
    classifyRelease([{ author: null, message: "fix: something" }]).auto,
    false,
  );
});

test("no runtime dependency fix, breaking changes, or nothing at all → manual", () => {
  assert.equal(classifyRelease([dep("chore(deps): bump eslint")]).auto, false);
  assert.equal(
    classifyRelease([dep("fix(deps)!: bump openid-client to 7")]).auto,
    false,
  );
  assert.equal(
    classifyRelease([dep("fix(deps): bump x\n\nBREAKING CHANGE: y")]).auto,
    false,
  );
  assert.equal(classifyRelease([]).auto, false);
});
