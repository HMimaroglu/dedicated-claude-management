import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { _setKeyForTests, decryptString, encryptString } from "../src/lib/crypto";

describe("crypto (AES-256-GCM)", () => {
  beforeEach(() => {
    _setKeyForTests(crypto.randomBytes(32));
  });
  afterEach(() => {
    _setKeyForTests(null);
  });

  it("roundtrips plaintext", () => {
    const pt = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
    const ct = encryptString(pt);
    expect(ct).not.toContain("BEGIN");
    expect(decryptString(ct)).toBe(pt);
  });

  it("produces different ciphertext each call (random nonce)", () => {
    const a = encryptString("same");
    const b = encryptString("same");
    expect(a).not.toBe(b);
    expect(decryptString(a)).toBe("same");
    expect(decryptString(b)).toBe("same");
  });

  it("fails to decrypt with wrong key", () => {
    const ct = encryptString("secret");
    _setKeyForTests(crypto.randomBytes(32));
    expect(() => decryptString(ct)).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const ct = encryptString("secret");
    const buf = Buffer.from(ct, "base64");
    const lastIdx = buf.length - 1;
    buf.writeUInt8(buf.readUInt8(lastIdx) ^ 0xff, lastIdx);
    const tampered = buf.toString("base64");
    expect(() => decryptString(tampered)).toThrow();
  });

  it("rejects ciphertext that is too short", () => {
    expect(() => decryptString(Buffer.from("short").toString("base64"))).toThrow();
  });
});
