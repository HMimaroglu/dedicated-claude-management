import argon2 from "argon2";
import crypto from "node:crypto";

// OWASP Argon2 cheat sheet (2024). Going above the minimum since we control the host:
// m=64 MiB raises offline-cracking cost meaningfully for ~50ms hash time.
export const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

// Password policy: any non-empty password up to MAX_PASSWORD_LENGTH. The
// upper bound exists only to prevent argon2 DoS from multi-MB inputs; it is
// not a strength requirement. The operator explicitly opted out of a minimum.
export const MIN_PASSWORD_LENGTH = 1;
export const MAX_PASSWORD_LENGTH = 4096;
// Leading char must be alphanumeric so the username can never be mistaken for a
// CLI flag if it ever flows into a shell argv (defense in depth — we use exec
// with arg arrays, but tighten the input anyway).
export const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}$/;

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateUsername(u: unknown): ValidationResult {
  if (typeof u !== "string") return { ok: false, reason: "Username required" };
  if (!USERNAME_PATTERN.test(u)) {
    return { ok: false, reason: "Username must be 3–32 chars (letters, digits, _, -)" };
  }
  return { ok: true };
}

export function validatePassword(pw: unknown): ValidationResult {
  if (typeof pw !== "string") return { ok: false, reason: "Password required" };
  if (pw.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: "Password must not be empty" };
  }
  if (pw.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at most ${MAX_PASSWORD_LENGTH} characters` };
  }
  if (pw.includes("\0")) return { ok: false, reason: "Password contains invalid characters" };
  return { ok: true };
}

export async function hashPassword(pw: string): Promise<string> {
  return argon2.hash(pw, ARGON2_OPTS);
}

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

// Eagerly compute so the first unknown-user login isn't measurably slower.
const _dummyHash: Promise<string> = argon2.hash("dummy-password-not-real", ARGON2_OPTS);
export function getDummyHash(): Promise<string> {
  return _dummyHash;
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
