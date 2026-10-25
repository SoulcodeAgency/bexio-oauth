import { describe as group, expect, it } from "vitest";
import * as oidc from "openid-client";
import { describe } from "./oidc.js";

group("describe", () => {
  it("keeps the OAuth error code and HTTP status of a token endpoint error, not the body", () => {
    const error = new oidc.ResponseBodyError("server responded with an error", {
      cause: {
        error: "invalid_grant",
        error_description: "Token is not active: secret-refresh-token",
      },
      response: new Response(null, { status: 400 }),
    });
    const summary = describe(error);
    expect(summary).toEqual({
      name: "ResponseBodyError",
      error: "invalid_grant",
      status: 400,
    });
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("keeps the error code of an authorization response error", () => {
    const error = new oidc.AuthorizationResponseError("authorization error", {
      cause: new URLSearchParams({
        error: "access_denied",
        error_description: "user said no",
      }),
    });
    expect(describe(error)).toEqual({
      name: "AuthorizationResponseError",
      error: "access_denied",
    });
  });

  it("keeps a string code of other errors, never the message", () => {
    const withCode = Object.assign(new Error("token abc leaked here"), {
      code: "ERR_JWKS_TIMEOUT",
    });
    expect(describe(withCode)).toEqual({
      name: "Error",
      error: "ERR_JWKS_TIMEOUT",
    });
    expect(describe(new TypeError("fetch failed"))).toEqual({
      name: "TypeError",
    });
    expect(describe(Object.assign(new Error("x"), { code: 42 }))).toEqual({
      name: "Error",
    });
  });

  it("summarizes non-errors as unknown", () => {
    expect(describe("secret")).toEqual({ name: "unknown" });
    expect(describe(undefined)).toEqual({ name: "unknown" });
  });
});
