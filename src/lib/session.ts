import { cookies } from "next/headers";
import type { Db } from "./db";
import { getDb } from "./db";
import { generateSessionToken, hashSessionToken } from "./auth";

export const SESSION_COOKIE_NAME = process.env.DCM_SESSION_COOKIE || "dcm_session";
// Secure-by-default in production. Override only with explicit "false" (e.g.,
// when intentionally serving over HTTP on a trusted local network).
const SECURE =
  process.env.DCM_SECURE_COOKIES === undefined
    ? process.env.NODE_ENV === "production"
    : process.env.DCM_SECURE_COOKIES === "true";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

export interface SessionUser {
  id: number;
  username: string;
}

export function createSession(opts: {
  userId: number;
  ip?: string | null;
  userAgent?: string | null;
  db?: Db;
}): { token: string; expiresAt: number } {
  const d = opts.db ?? getDb();
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  d.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(tokenHash, opts.userId, now, expiresAt, now, opts.ip ?? null, opts.userAgent ?? null);
  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: number): Promise<void> {
  const c = await cookies();
  c.set({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: SECURE,
    // Strict is fine: this is a single-admin tool with no third-party-link UX,
    // and prevents any future GET-with-side-effects mistake from being CSRF-able.
    sameSite: "strict",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function clearSessionCookie(): Promise<void> {
  const c = await cookies();
  c.delete(SESSION_COOKIE_NAME);
}

export async function getSessionUser(d?: Db): Promise<SessionUser | null> {
  const c = await cookies();
  const token = c.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return getSessionUserByToken(token, d);
}

export function getSessionUserByToken(token: string, d?: Db): SessionUser | null {
  const db = d ?? getDb();
  const tokenHash = hashSessionToken(token);
  const now = Date.now();
  const row = db
    .prepare(
      `SELECT s.expires_at as expires_at, u.id as id, u.username as username
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`
    )
    .get(tokenHash) as { expires_at: number; id: number; username: string } | undefined;
  if (!row) return null;
  if (row.expires_at <= now) return null;
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, tokenHash);
  return { id: row.id, username: row.username };
}

export function destroySession(token: string, d?: Db): void {
  const db = d ?? getDb();
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSessionToken(token));
}

// Call on credential change (password reset, future password rotation) to honor
// OWASP ASVS 3.3.3: invalidate all other sessions for that user.
export function destroyAllSessionsForUser(userId: number, d?: Db): number {
  const db = d ?? getDb();
  const r = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return r.changes;
}

export function purgeExpiredSessions(d?: Db): number {
  const db = d ?? getDb();
  const r = db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  return r.changes;
}
