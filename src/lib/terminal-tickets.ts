import type { Db } from "./db";
import { getDb } from "./db";
import { generateSessionToken, hashSessionToken } from "./auth";

export interface IssuedTicket {
  token: string; // the opaque token the browser uses
  expiresAt: number;
}

export interface RedeemedTicket {
  instanceId: number;
  userId: number;
}

const TICKET_TTL_MS = 30_000; // 30 seconds — terminal connect should be fast

export function issueTerminalTicket(opts: {
  instanceId: number;
  userId: number;
  db?: Db;
}): IssuedTicket {
  const db = opts.db ?? getDb();
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const now = Date.now();
  const expiresAt = now + TICKET_TTL_MS;
  db.prepare(
    "INSERT INTO terminal_tickets (token_hash, instance_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
  ).run(tokenHash, opts.instanceId, opts.userId, now, expiresAt);
  return { token, expiresAt };
}

// One-shot redeem: returns the ticket payload and marks it used. Returns null
// if the ticket is missing, expired, or already consumed.
export function redeemTerminalTicket(token: string, d?: Db): RedeemedTicket | null {
  const db = d ?? getDb();
  const tokenHash = hashSessionToken(token);
  const now = Date.now();
  const row = db
    .prepare(
      "SELECT instance_id, user_id, expires_at, used_at FROM terminal_tickets WHERE token_hash = ?"
    )
    .get(tokenHash) as { instance_id: number; user_id: number; expires_at: number; used_at: number | null } | undefined;
  if (!row) return null;
  if (row.used_at !== null) return null;
  if (row.expires_at <= now) return null;
  const r = db
    .prepare(
      "UPDATE terminal_tickets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL"
    )
    .run(now, tokenHash);
  if (r.changes !== 1) return null; // racing redeemer won
  return { instanceId: row.instance_id, userId: row.user_id };
}

export function purgeExpiredTickets(d?: Db): number {
  const db = d ?? getDb();
  const now = Date.now();
  const r = db.prepare("DELETE FROM terminal_tickets WHERE expires_at <= ?").run(now);
  return r.changes;
}

export const TERMINAL_TICKET_TTL_MS = TICKET_TTL_MS;
