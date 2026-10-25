import { describe, expect, it } from "vitest";
import { generateKey, TokenCipher } from "./crypto.js";
import {
  FLOW_COOKIE,
  flowCookie,
  readCookie,
  readFlow,
  sealFlow,
  type FlowState,
} from "./flow-cookie.js";

const withCookie = (cookie?: string) =>
  new Request("https://app.example.com/cb", {
    headers: cookie === undefined ? {} : { cookie },
  });

describe("readCookie", () => {
  it("finds one cookie among several", () => {
    const request = withCookie("a=1; bexio_oauth_flow=abc.def; b=2");
    expect(readCookie(request, "bexio_oauth_flow")).toBe("abc.def");
    expect(readCookie(request, "a")).toBe("1");
    expect(readCookie(request, "b")).toBe("2");
  });

  it("tolerates odd spacing and keeps '=' inside the value", () => {
    const request = withCookie("  a = 1 ;b=x=y;;  c=  ");
    expect(readCookie(request, "a")).toBe("1");
    expect(readCookie(request, "b")).toBe("x=y");
    expect(readCookie(request, "c")).toBe("");
  });

  it("returns null when the cookie or the header is missing", () => {
    expect(readCookie(withCookie("a=1; flag"), "b")).toBeNull();
    expect(readCookie(withCookie("flag"), "flag")).toBeNull();
    expect(readCookie(withCookie(), "a")).toBeNull();
  });

  it("matches the name exactly, not by prefix", () => {
    expect(readCookie(withCookie("ab=1; a=2"), "a")).toBe("2");
    expect(readCookie(withCookie("ab=1"), "a")).toBeNull();
  });
});

describe("flowCookie", () => {
  it("scopes the cookie to the callback path, Secure on https", () => {
    expect(flowCookie(new URL("https://app.example.com/cb"), "v", 600)).toBe(
      `${FLOW_COOKIE}=v; Path=/cb; Max-Age=600; HttpOnly; SameSite=Lax; Secure`,
    );
    expect(flowCookie(new URL("http://localhost/api/cb"), "", 0)).toBe(
      `${FLOW_COOKIE}=; Path=/api/cb; Max-Age=0; HttpOnly; SameSite=Lax`,
    );
  });
});

describe("sealFlow / readFlow", () => {
  const cipher = new TokenCipher({
    current: "k1",
    keys: { k1: generateKey() },
  });
  const flow: FlowState = { s: "st", v: "ver", n: "no", o: "ws", r: "/x" };
  const now = new Date("2026-01-01T00:00:00Z");

  it("round-trips the flow through the request's cookie until it expires", async () => {
    const sealed = await sealFlow(cipher, flow, now);
    const request = withCookie(`other=1; ${FLOW_COOKIE}=${sealed}`);
    expect(await readFlow(cipher, request, now)).toMatchObject(flow);
    expect(
      await readFlow(cipher, request, new Date(now.getTime() + 601_000)),
    ).toBeNull();
  });

  it("returns null for a missing or tampered cookie", async () => {
    expect(await readFlow(cipher, withCookie(), now)).toBeNull();
    expect(
      await readFlow(cipher, withCookie(`${FLOW_COOKIE}=garbage`), now),
    ).toBeNull();
  });
});
