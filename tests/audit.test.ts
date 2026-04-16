import { describe, expect, it } from "vitest";
import { createDb } from "../src/lib/db";
import { audit } from "../src/lib/audit";

describe("audit log", () => {
  it("records event with details", () => {
    const db = createDb(":memory:");
    audit({ event: "user.login_failed", ip: "1.2.3.4", details: { username: "x" }, db });
    const row = db.prepare("SELECT event, ip, details FROM audit_log").get() as {
      event: string;
      ip: string;
      details: string;
    };
    expect(row.event).toBe("user.login_failed");
    expect(row.ip).toBe("1.2.3.4");
    expect(JSON.parse(row.details)).toEqual({ username: "x" });
    db.close();
  });

  it("foreign key set null on user delete", () => {
    const db = createDb(":memory:");
    const u = db
      .prepare("INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("alice", "h", 1, 1);
    const userId = Number(u.lastInsertRowid);
    audit({ event: "user.created", actorUserId: userId, db });
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    const row = db.prepare("SELECT actor_user_id FROM audit_log").get() as {
      actor_user_id: number | null;
    };
    expect(row.actor_user_id).toBeNull();
    db.close();
  });
});
