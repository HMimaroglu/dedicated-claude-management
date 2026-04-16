import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { decideHostKey, redactError } from "../src/lib/ssh";

describe("decideHostKey (TOFU)", () => {
  it("accepts on first connect (no stored fingerprint)", () => {
    const key = crypto.randomBytes(32);
    const d = decideHostKey(null, key);
    expect(d.accept).toBe(true);
    expect(d.firstSeen).toBe(true);
    expect(d.mismatch).toBe(false);
    expect(d.fingerprint).toMatch(/^SHA256:/);
  });

  it("accepts matching stored fingerprint", () => {
    const key = crypto.randomBytes(32);
    const fp = decideHostKey(null, key).fingerprint;
    const d = decideHostKey(fp, key);
    expect(d.accept).toBe(true);
    expect(d.mismatch).toBe(false);
  });

  it("refuses mismatched key", () => {
    const key1 = crypto.randomBytes(32);
    const key2 = crypto.randomBytes(32);
    const fp1 = decideHostKey(null, key1).fingerprint;
    const d = decideHostKey(fp1, key2);
    expect(d.accept).toBe(false);
    expect(d.mismatch).toBe(true);
  });
});

describe("redactError", () => {
  it("removes PEM bodies", () => {
    const msg =
      "could not parse -----BEGIN OPENSSH PRIVATE KEY-----\nabcd\nmore\n-----END OPENSSH PRIVATE KEY----- bad key";
    const out = redactError(msg);
    expect(out).toContain("[REDACTED PEM]");
    expect(out).not.toContain("BEGIN");
    expect(out).not.toContain("END");
  });

  it("collapses long base64 runs", () => {
    const msg = "auth failed: " + "A".repeat(200);
    const out = redactError(msg);
    expect(out.length).toBeLessThan(msg.length);
    expect(out).toContain("[REDACTED]");
  });

  it("clips overlong error", () => {
    const out = redactError("x".repeat(1000));
    expect(out.length).toBeLessThanOrEqual(513);
  });

  it("passes short messages unchanged", () => {
    expect(redactError("auth failed")).toBe("auth failed");
  });
});
