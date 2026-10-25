import { describe, expect, it } from "vitest";
import { fetchRole, roleFromPermissions } from "./permissions.js";

describe("roleFromPermissions", () => {
  it("maps admin.activation 'enabled' to admin, everything else to member", () => {
    expect(
      roleFromPermissions({
        permissions: { admin: { activation: "enabled" } },
      }),
    ).toBe("admin");
    expect(
      roleFromPermissions({
        permissions: { admin: { activation: "disabled" } },
      }),
    ).toBe("member");
    expect(
      roleFromPermissions({
        permissions: { admin: { activation: "ENABLED" } },
      }),
    ).toBe("member");
    expect(roleFromPermissions({ permissions: {} })).toBe("member");
    expect(roleFromPermissions(null)).toBe("member");
  });
});

describe("fetchRole", () => {
  it("returns null when the permissions call fails, so callers keep the previous role", async () => {
    const failing = (async () =>
      new Response("nope", { status: 500 })) as typeof fetch;
    const throwing = (async () => {
      throw new TypeError("network");
    }) as typeof fetch;
    await expect(
      fetchRole(failing, "https://api.example.com", "t"),
    ).resolves.toBeNull();
    await expect(
      fetchRole(throwing, "https://api.example.com", "t"),
    ).resolves.toBeNull();
  });

  it("calls GET /3.0/permissions with the bearer token", async () => {
    let seen: Request | undefined;
    const ok = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      seen = new Request(input, init);
      return Response.json({
        permissions: { admin: { activation: "enabled" } },
      });
    }) as typeof fetch;
    await expect(fetchRole(ok, "https://api.example.com", "tok")).resolves.toBe(
      "admin",
    );
    expect(seen?.url).toBe("https://api.example.com/3.0/permissions");
    expect(seen?.headers.get("authorization")).toBe("Bearer tok");
  });
});
