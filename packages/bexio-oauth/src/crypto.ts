import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { CompactEncrypt, compactDecrypt, EncryptJWT, jwtDecrypt } from "jose";
import type { CompactJWEHeaderParameters, JWTPayload } from "jose";
import { BexioOAuthError } from "./errors.js";

/**
 * Encryption keys, by key id. `current` is used for new writes; every key in
 * `keys` can still decrypt. Keys are 32 random bytes, base64url-encoded
 * (`npx @soulcode/bexio-oauth keygen`).
 */
export interface Keyring {
  current: string;
  keys: Record<string, string>;
}

const JWE_ALGORITHMS = {
  keyManagementAlgorithms: ["dir"],
  contentEncryptionAlgorithms: ["A256GCM"],
};

/** A new random key for the keyring, base64url-encoded. */
export function generateKey(): string {
  return randomBytes(32).toString("base64url");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/**
 * Encrypts tokens at rest as compact JWE (`dir` + `A256GCM`) and seals the
 * short-lived flow cookie. The `bxg` protected header binds a token to the
 * grant it belongs to, so ciphertext copied to another row fails to decrypt.
 */
export class TokenCipher {
  readonly #current: string;
  readonly #keys: Map<string, Uint8Array>;
  readonly #flowKeys = new Map<string, Uint8Array>();

  constructor(keyring: Keyring) {
    if (!keyring || typeof keyring !== "object" || !keyring.keys) {
      throw new BexioOAuthError(
        "invalid_config",
        "keys must be { current, keys }",
      );
    }
    this.#keys = new Map();
    for (const [kid, encoded] of Object.entries(keyring.keys)) {
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.length !== 32) {
        throw new BexioOAuthError(
          "invalid_config",
          `key "${kid}" must be 32 bytes, base64url-encoded`,
        );
      }
      this.#keys.set(kid, new Uint8Array(bytes));
    }
    if (!this.#keys.has(keyring.current)) {
      throw new BexioOAuthError(
        "invalid_config",
        `keys.current "${keyring.current}" is not in keys`,
      );
    }
    this.#current = keyring.current;
  }

  async encrypt(plaintext: string, binding: string): Promise<string> {
    return new CompactEncrypt(new TextEncoder().encode(plaintext))
      .setProtectedHeader({
        alg: "dir",
        enc: "A256GCM",
        kid: this.#current,
        bxg: hash(binding),
      })
      .encrypt(this.#key(this.#current).key);
  }

  async decrypt(jwe: string, binding: string): Promise<string> {
    try {
      const { plaintext, protectedHeader } = await compactDecrypt(
        jwe,
        (header: CompactJWEHeaderParameters) => this.#key(header.kid).key,
        JWE_ALGORITHMS,
      );
      if (protectedHeader.bxg !== hash(binding)) {
        throw new Error("binding mismatch");
      }
      return new TextDecoder().decode(plaintext);
    } catch {
      throw new BexioOAuthError(
        "decryption_failed",
        "stored token could not be decrypted (unknown key id, or it belongs to another grant)",
      );
    }
  }

  async seal(
    payload: JWTPayload,
    ttlSeconds: number,
    now: Date,
  ): Promise<string> {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    return new EncryptJWT(payload)
      .setProtectedHeader({ alg: "dir", enc: "A256GCM", kid: this.#current })
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + ttlSeconds)
      .encrypt(this.#flowKey(this.#current));
  }

  /** Returns the payload, or `null` when the value is invalid or expired. */
  async unseal(token: string, now: Date): Promise<JWTPayload | null> {
    try {
      const { payload } = await jwtDecrypt(
        token,
        (header) => this.#flowKey(header.kid),
        {
          ...JWE_ALGORITHMS,
          currentDate: now,
        },
      );
      return payload;
    } catch {
      return null;
    }
  }

  /** The key for `kid`, with `kid` narrowed to a known key id. */
  #key(kid: string | undefined): { kid: string; key: Uint8Array } {
    const key = kid === undefined ? undefined : this.#keys.get(kid);
    if (kid === undefined || !key) throw new Error("unknown key id");
    return { kid, key };
  }

  // The flow cookie uses a key derived from the keyring, never the token key itself.
  #flowKey(requested: string | undefined): Uint8Array {
    const { kid, key: base } = this.#key(requested);
    let derived = this.#flowKeys.get(kid);
    if (!derived) {
      derived = new Uint8Array(
        hkdfSync(
          "sha256",
          base,
          new Uint8Array(0),
          "bexio-oauth/flow-cookie",
          32,
        ),
      );
      this.#flowKeys.set(kid, derived);
    }
    return derived;
  }
}
