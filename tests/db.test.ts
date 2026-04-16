import { describe, expect, it } from "vitest";
import { createDb, hasAnyUser } from "../src/lib/db";

describe("db", () => {
  it("creates schema and is idempotent", () => {
    const d = createDb(":memory:");
    expect(hasAnyUser(d)).toBe(false);
    // re-running migrations on the same connection should not throw
    d.exec(
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );`
    );
    d.close();
  });

  it("hasAnyUser flips after insert", () => {
    const d = createDb(":memory:");
    expect(hasAnyUser(d)).toBe(false);
    d.prepare(
      "INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run("alice", "h", Date.now(), Date.now());
    expect(hasAnyUser(d)).toBe(true);
    d.close();
  });

  it("enforces unique username", () => {
    const d = createDb(":memory:");
    const stmt = d.prepare(
      "INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)"
    );
    stmt.run("alice", "h", 1, 1);
    expect(() => stmt.run("alice", "h", 2, 2)).toThrow();
    d.close();
  });

  it("cascades sessions when user is deleted", () => {
    const d = createDb(":memory:");
    const u = d
      .prepare(
        "INSERT INTO users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)"
      )
      .run("alice", "h", 1, 1);
    const userId = Number(u.lastInsertRowid);
    d.prepare(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)"
    ).run("th", userId, 1, 999_999_999_999, 1);
    d.prepare("DELETE FROM users WHERE id = ?").run(userId);
    const count = d.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number };
    expect(count.c).toBe(0);
    d.close();
  });
});
