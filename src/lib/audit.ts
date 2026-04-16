import type { Db } from "./db";
import { getDb } from "./db";

export type AuditEvent =
  | "user.created"
  | "user.login"
  | "user.login_failed"
  | "user.logout"
  | "session.created"
  | "session.destroyed"
  | "host.created"
  | "host.updated"
  | "host.deleted"
  | "host.probe_manual"
  | "host.unquarantined"
  | "project.created"
  | "project.updated"
  | "project.deleted"
  | "project.cloned"
  | "instance.created"
  | "instance.spawned"
  | "instance.killed"
  | "instance.deleted"
  | "instance.paused"
  | "instance.resumed"
  | "instance.auto_restart_toggled";

export function audit(opts: {
  event: AuditEvent;
  actorUserId?: number | null;
  ip?: string | null;
  details?: Record<string, unknown>;
  db?: Db;
}): void {
  const db = opts.db ?? getDb();
  db.prepare(
    `INSERT INTO audit_log (event, actor_user_id, ip, details, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(
    opts.event,
    opts.actorUserId ?? null,
    opts.ip ?? null,
    opts.details ? JSON.stringify(opts.details) : null,
    Date.now()
  );
}
