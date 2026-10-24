import { describe, expect, it } from "vitest";
import { mapClaims } from "./claims.js";

describe("mapClaims", () => {
  it("reads Bexio's claims from merged ID token + access token claims", () => {
    expect(
      mapClaims({
        sub: "u1",
        company_id: "cmp-1",
        company_name: "Alpha AG",
        company_user_id: "7",
        login_id: "l1",
        email: "ada@example.com",
        given_name: "Ada",
        family_name: "Lovelace",
      }),
    ).toEqual({
      userId: "u1",
      companyId: "cmp-1",
      companyName: "Alpha AG",
      companyUserId: 7,
      userName: "Ada Lovelace",
      userEmail: "ada@example.com",
    });
  });

  it("falls back to name and tolerates missing optional claims", () => {
    expect(
      mapClaims({ sub: "u1", company_id: 42, name: "Grace" }),
    ).toMatchObject({
      companyId: "42",
      userName: "Grace",
      companyName: null,
      companyUserId: null,
      userEmail: null,
    });
  });

  it("requires sub and company_id", () => {
    expect(() => mapClaims({ company_id: "c" })).toThrow(/sub/);
    expect(() => mapClaims({ sub: "u" })).toThrow(/company_profile/);
  });
});
