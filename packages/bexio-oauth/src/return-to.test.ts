import { describe, expect, it } from "vitest";
import { OFF_SITE_RETURN_TO } from "../test/return-to-attacks.js";
import { safeReturnTo } from "./return-to.js";

describe("safeReturnTo", () => {
  it("returns the fallback for a missing or empty value", () => {
    expect(safeReturnTo(undefined, "/home")).toBe("/home");
    expect(safeReturnTo("", "/home")).toBe("/home");
  });

  it("keeps relative paths, normalized to path, query and hash", () => {
    expect(safeReturnTo("/settings", "/")).toBe("/settings");
    expect(safeReturnTo("/a/b?x=1&y=2#top", "/")).toBe("/a/b?x=1&y=2#top");
    expect(safeReturnTo("/a/./b/../c", "/")).toBe("/a/c");
  });

  it.each(OFF_SITE_RETURN_TO)("refuses %j with invalid_config", (value) => {
    expect(() => safeReturnTo(value, "/")).toThrow(
      expect.objectContaining({ code: "invalid_config" }),
    );
  });

  it("refuses paths without a leading slash", () => {
    for (const value of ["settings", "javascript:alert(1)", " /settings"])
      expect(() => safeReturnTo(value, "/")).toThrow(/relative path/);
  });
});
