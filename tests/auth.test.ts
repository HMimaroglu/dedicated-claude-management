import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  generateSessionToken,
  getDummyHash,
  hashPassword,
  hashSessionToken,
  validatePassword,
  validateUsername,
  verifyPassword,
} from "../src/lib/auth";

describe("validators", () => {
  it("accepts any non-empty password (no minimum length)", () => {
    expect(validatePassword("a").ok).toBe(true);
    expect(validatePassword("short").ok).toBe(true);
    expect(validatePassword("correcthorse").ok).toBe(true);
  });

  it("rejects empty password", () => {
    expect(validatePassword("").ok).toBe(false);
  });

  it("caps at MAX_PASSWORD_LENGTH to prevent argon2 DoS", () => {
    expect(validatePassword("a".repeat(4096)).ok).toBe(true);
    expect(validatePassword("a".repeat(4097)).ok).toBe(false);
  });

  it("rejects null bytes in passwords", () => {
    expect(validatePassword("abc\0def").ok).toBe(false);
  });

  it("rejects non-string passwords", () => {
    expect(validatePassword(undefined).ok).toBe(false);
    expect(validatePassword(123).ok).toBe(false);
  });

  it("validates username pattern (alphanumeric first char, 3-32)", () => {
    expect(validateUsername("ab").ok).toBe(false);
    expect(validateUsername("abc").ok).toBe(true);
    expect(validateUsername("a_b-2").ok).toBe(true);
    expect(validateUsername("bad space").ok).toBe(false);
    expect(validateUsername("bad/char").ok).toBe(false);
    expect(validateUsername("a".repeat(32)).ok).toBe(true);
    expect(validateUsername("a".repeat(33)).ok).toBe(false);
    // Defense in depth: must not start with - or _ (would look like CLI flag)
    expect(validateUsername("-evil").ok).toBe(false);
    expect(validateUsername("_evil").ok).toBe(false);
  });
});

describe("password hashing", () => {
  it("argon2id roundtrip works", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });

  it("verifyPassword returns false for malformed hash", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });

  it("dummy hash is valid argon2id", async () => {
    const dummy = await getDummyHash();
    expect(dummy).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(dummy, "anything-else")).toBe(false);
  });
});

describe("session tokens", () => {
  it("generates unique 256-bit tokens", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    // base64url of 32 bytes is ~43 chars
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(/^[A-Za-z0-9_-]+$/.test(a)).toBe(true);
  });

  it("hashSessionToken is deterministic SHA-256", () => {
    const t = "abc";
    expect(hashSessionToken(t)).toBe(hashSessionToken(t));
    expect(hashSessionToken("abc")).not.toBe(hashSessionToken("abd"));
  });
});

describe("constantTimeEqual", () => {
  it("true for equal strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
  });
  it("false for different lengths", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
  it("false for same length, different bytes", () => {
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });
});
