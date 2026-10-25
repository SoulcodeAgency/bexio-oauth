import { describe, expect, it } from "vitest";
import { decodeProtectedHeader } from "jose";
import { generateKey, TokenCipher } from "./crypto.js";
import { BexioOAuthError } from "./errors.js";

const k1 = generateKey();
const k2 = generateKey();

describe("TokenCipher", () => {
  it("round-trips a token as dir/A256GCM JWE with the current kid", async () => {
    const cipher = new TokenCipher({ current: "k1", keys: { k1 } });
    const jwe = await cipher.encrypt("secret-token", "owner\0cmp\0sub");
    expect(jwe).not.toContain("secret-token");
    expect(decodeProtectedHeader(jwe)).toMatchObject({
      alg: "dir",
      enc: "A256GCM",
      kid: "k1",
    });
    await expect(cipher.decrypt(jwe, "owner\0cmp\0sub")).resolves.toBe(
      "secret-token",
    );
  });

  it("keeps decrypting old rows after rotation and writes with the new kid", async () => {
    const before = new TokenCipher({ current: "k1", keys: { k1 } });
    const old = await before.encrypt("old", "b");
    const after = new TokenCipher({ current: "k2", keys: { k1, k2 } });
    await expect(after.decrypt(old, "b")).resolves.toBe("old");
    expect(decodeProtectedHeader(await after.encrypt("new", "b")).kid).toBe(
      "k2",
    );
  });

  it("refuses ciphertext that belongs to another grant", async () => {
    const cipher = new TokenCipher({ current: "k1", keys: { k1 } });
    const jwe = await cipher.encrypt("t", "owner-a\0cmp\0sub");
    await expect(
      cipher.decrypt(jwe, "owner-b\0cmp\0sub"),
    ).rejects.toMatchObject({
      code: "decryption_failed",
    });
  });

  it("fails with decryption_failed when the key was removed", async () => {
    const jwe = await new TokenCipher({ current: "k1", keys: { k1 } }).encrypt(
      "t",
      "b",
    );
    await expect(
      new TokenCipher({ current: "k2", keys: { k2 } }).decrypt(jwe, "b"),
    ).rejects.toBeInstanceOf(BexioOAuthError);
  });

  it("rejects malformed keyrings", () => {
    expect(
      () => new TokenCipher({ current: "k1", keys: { k1: "short" } }),
    ).toThrow(/32 bytes/);
    expect(() => new TokenCipher({ current: "nope", keys: { k1 } })).toThrow(
      /not in keys/,
    );
  });

  it("seals and unseals the flow cookie, and rejects it once expired", async () => {
    const cipher = new TokenCipher({ current: "k1", keys: { k1 } });
    const now = new Date("2026-01-01T00:00:00Z");
    const sealed = await cipher.seal({ s: "state" }, 600, now);
    expect(await cipher.unseal(sealed, now)).toMatchObject({ s: "state" });
    expect(
      await cipher.unseal(sealed, new Date(now.getTime() + 601_000)),
    ).toBeNull();
    expect(await cipher.unseal("garbage", now)).toBeNull();
  });
});
