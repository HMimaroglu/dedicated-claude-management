import type { Db } from "./db";
import { getDb } from "./db";

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILED_PER_IP = 5;
// Per-username/global cap so an attacker rotating IPs (botnet, IPv6, Tor) can't
// bypass per-IP throttling against the single admin account. Sized tight
// (10 / 15 min) because the operator may choose a short password — the
// per-username limit becomes the dominant defense when entropy is low.
export const LOGIN_MAX_FAILED_PER_USERNAME = 10;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  reason?: "ip" | "username";
}

export function checkLoginRateLimit(opts: {
  ip: string;
  username?: string;
  db?: Db;
}): RateLimitResult {
  const db = opts.db ?? getDb();
  const cutoff = Date.now() - LOGIN_WINDOW_MS;

  const ipRow = db
    .prepare(
      `SELECT COUNT(*) as c, MIN(attempted_at) as oldest
       FROM login_attempts
       WHERE ip = ? AND succeeded = 0 AND attempted_at >= ?`
    )
    .get(opts.ip, cutoff) as { c: number; oldest: number | null } | undefined;
  const ipFailed = ipRow?.c ?? 0;
  if (ipFailed >= LOGIN_MAX_FAILED_PER_IP) {
    const oldest = ipRow?.oldest ?? Date.now();
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: Math.max(0, oldest + LOGIN_WINDOW_MS - Date.now()),
      reason: "ip",
    };
  }

  if (opts.username) {
    const userRow = db
      .prepare(
        `SELECT COUNT(*) as c, MIN(attempted_at) as oldest
         FROM login_attempts
         WHERE username = ? AND succeeded = 0 AND attempted_at >= ?`
      )
      .get(opts.username, cutoff) as { c: number; oldest: number | null } | undefined;
    const userFailed = userRow?.c ?? 0;
    if (userFailed >= LOGIN_MAX_FAILED_PER_USERNAME) {
      const oldest = userRow?.oldest ?? Date.now();
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, oldest + LOGIN_WINDOW_MS - Date.now()),
        reason: "username",
      };
    }
  }

  return {
    allowed: true,
    remaining: LOGIN_MAX_FAILED_PER_IP - ipFailed,
    retryAfterMs: 0,
  };
}

export function recordLoginAttempt(opts: {
  ip: string;
  username?: string;
  succeeded: boolean;
  db?: Db;
}): void {
  const db = opts.db ?? getDb();
  db.prepare(
    `INSERT INTO login_attempts (ip, username, succeeded, attempted_at) VALUES (?, ?, ?, ?)`
  ).run(opts.ip, opts.username ?? null, opts.succeeded ? 1 : 0, Date.now());
  if (opts.succeeded) {
    const cutoff = Date.now() - LOGIN_WINDOW_MS;
    db.prepare("DELETE FROM login_attempts WHERE ip = ? AND attempted_at < ?").run(
      opts.ip,
      cutoff
    );
  }
}
