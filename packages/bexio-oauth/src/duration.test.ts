import { describe, expect, it } from "vitest";
import { toMs } from "./duration.js";

describe("toMs", () => {
  it("parses numbers and unit strings", () => {
    expect(toMs(1500, "x")).toBe(1500);
    expect(toMs("30s", "x")).toBe(30_000);
    expect(toMs("15m", "x")).toBe(900_000);
    expect(toMs("12h", "x")).toBe(43_200_000);
    expect(toMs("7d", "x")).toBe(604_800_000);
  });

  it("rejects invalid values", () => {
    expect(() => toMs(0, "idleFor")).toThrow(/idleFor/);
    expect(() => toMs("7w" as never, "idleFor")).toThrow();
  });
});
